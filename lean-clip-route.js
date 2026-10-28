// Routes checked and planned with the game's own movement clipper (lean-clipper.js).
// The flat grid in lean-navigation.js reads terrain tiles and object walls in 2D, so
// it closes towns whose ways out are object floors over blocked terrain, ramps and
// bridges (issue #36, Hotan). The clipper clips every move the way the server does:
// it checks each flat route, and plans where the check fails. A* over a fixed lattice
// of 40-unit cells, every move clipped, one node per cell and height level (a bridge
// and the ground under it are two places); the clipper's answer for a lattice move is
// kept until the next product, so legs, detours and replans in one town reuse it.
// A search runs in slices of a few milliseconds between the game's frames, so the page
// never freezes; meanwhile the walker is told to wait. A destination it could not reach
// is not searched again for a while.
const CLIP_CELL = 40;           // lattice cell, and the longest step checked in one clip
const CLIP_LEVEL = 12;          // height band of one node
const CLIP_REACHED = 2;         // a clipped step ending this close to its target went through
const CLIP_MAX_NODES = 8000;
const CLIP_SLICE_MS = 5;        // search time per slice; the game draws between slices
const CLIP_CPU_MS = 2500;       // total search time before a destination counts as unreachable
const CLIP_FAILED_MS = 30000;   // an unreachable destination is not searched again this long
const CLIP_PENDING = Object.freeze({ pending: true });
const CLIP_GREED = 1.5;         // weighted A*: a route at most this much longer, far fewer nodes
const CLIP_MAX_CHORD = 600;
const ClipRoute = {
  clipper: null, ready: false, moves: new Map(), failed: new Map(), job: null, token: null, message: '',
  // In its own task right after the flat grid, so the two costs do not add up to one
  // freeze. The clipper never writes into a product (clipper.ts), so it reads the one the
  // page sent the game. Once ready, walkers plan again (Navigation.revision).
  install(product) {
    this.reset();
    if (typeof NativeClipper === 'undefined') return;
    const token = this.token = {};
    setTimeout(() => {
      if (this.token !== token || Navigation.scene?.regionId !== product.regionId) return;
      try {
        this.clipper ||= NativeClipper.createNavigation();
        this.clipper.install(product.regionId, product);
        this.ready = true; this.message = ''; Navigation.revision++;
      } catch (e) { this.message = e.message; } // the flat grid alone plans in this region
    }, 0);
  },
  reset() { this.ready = false; this.moves = new Map(); this.failed = new Map(); this.job = null; this.token = null; },
  // One clipped move from a pose (with its height) to a local point: the pose reached, or null.
  step(from, x, z) {
    const to = { ...Navigation.pose({ x, z }, from.y), angle: 0 };
    const got = this.clipper.clip({ ...from, angle: 0 }, to, { slide: false });
    if (!got) return null;
    const g = Navigation.local(got);
    return g && Math.hypot(g.x - x, g.z - z) <= CLIP_REACHED ? got : null;
  },
  // A straight line in steps of at most one cell: the pose at its end, or null.
  chord(from, to) {
    const a = Navigation.local(from), b = Navigation.local(to);
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / CLIP_CELL));
    let at = from;
    for (let i = 1; i <= n && at; i++) at = this.step(at, a.x + (b.x - a.x) * i / n, a.z + (b.z - a.z) * i / n);
    return at;
  },
  walks(from, route) {
    if (!this.ready) return true;
    let at = from;
    for (const point of route) { at = this.chord(at, point); if (!at) return false; }
    return true;
  },
  // The points from a pose to another, each with its height; [] when the clipper finds no
  // way within its budget; CLIP_PENDING while the search runs (ask again, it carries on
  // between frames). avoid: local circles { x, z, r } kept out of the route.
  // The search a request belongs to: its start cell, destination cell, radius and the
  // spots it avoids. A failure is remembered for the destination with those same spots,
  // so a search that failed only because of them does not hold back the plain one.
  keys(from, to, arrivalRadius, avoid) {
    const s = Navigation.local(from), g = Navigation.local(to);
    if (!s || !g) return null;
    const spots = avoid.map(a => Math.round(a.x / CLIP_CELL) + ',' + Math.round(a.z / CLIP_CELL) + ',' + a.r).join(';');
    const goal = Math.round(g.x / CLIP_CELL) + ',' + Math.round(g.z / CLIP_CELL) + ',' + arrivalRadius + '|' + spots;
    return { goal, key: Math.round(s.x / CLIP_CELL) + ',' + Math.round(s.z / CLIP_CELL) + '>' + goal };
  },
  // Is this request's search already running? Then the flat planner need not try again.
  busy(from, to, arrivalRadius = 0, avoid = []) {
    return !!this.job && !this.job.result && this.job.key === this.keys(from, to, arrivalRadius, avoid)?.key;
  },
  plan(from, to, arrivalRadius = 0, avoid = []) {
    const k = this.keys(from, to, arrivalRadius, avoid);
    if (!k) return [];
    const { goal, key } = k;
    if ((this.failed.get(goal) ?? 0) > now()) return [];
    let job = this.job;
    if (job?.key !== key) job = this.job = { key, goal, steps: this.search(from, to, arrivalRadius, avoid), cpu: 0, result: null, driven: false };
    // A short search ends within its first slice, and is answered at once.
    if (!job.result) this.slice(job);
    if (job.result) { this.job = null; return job.result; }
    if (!job.driven) { job.driven = true; setTimeout(() => this.drive(job), 0); }
    return CLIP_PENDING;
  },
  slice(job) {
    const started = performance.now();
    for (;;) {
      const step = job.steps.next();
      if (step.done) { job.result = step.value; break; }
      if (performance.now() - started >= CLIP_SLICE_MS) break;
    }
    job.cpu += performance.now() - started;
    if (!job.result && job.cpu > CLIP_CPU_MS) job.result = [];
    if (job.result && !job.result.length) this.failed.set(job.goal, now() + CLIP_FAILED_MS);
  },
  drive(job) {
    if (this.job !== job || job.result) return;
    this.slice(job);
    if (!job.result) setTimeout(() => this.drive(job), 0);
  },
  // The A* itself, yielding after every node so slice() can stop between them.
  *search(from, to, arrivalRadius, avoid) {
    const s = Navigation.local(from), g = Navigation.local(to);
    const goalReach = Math.max(arrivalRadius, CLIP_CELL * 1.5);
    const h = (i, j) => Math.hypot(i * CLIP_CELL - g.x, j * CLIP_CELL - g.z);
    const key = (i, j, y) => i + ',' + j + ',' + Math.round(y / CLIP_LEVEL);
    const move = (n, a, b) => {
      const k = key(n.i, n.j, n.pose.y) + '>' + a + ',' + b;
      if (!this.moves.has(k)) this.moves.set(k, this.step(n.pose, a * CLIP_CELL, b * CLIP_CELL));
      return this.moves.get(k);
    };
    const heap = [], scores = new Map(), closed = new Set();
    const push = n => { heap.push(n); for (let c = heap.length - 1; c;) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let c = 0; ;) {
          const a = 2 * c + 1, b = a + 1; let m = c;
          if (a < heap.length && heap[a].f < heap[m].f) m = a;
          if (b < heap.length && heap[b].f < heap[m].f) m = b;
          if (m === c) break;
          [heap[m], heap[c]] = [heap[c], heap[m]]; c = m;
        }
      }
      return top;
    };
    const avoided = (x, z) => avoid.some(a => Math.hypot(x - a.x, z - a.z) < a.r);
    // The start joins the lattice at its own cell's corner when the clipper walks there.
    const i0 = Math.round(s.x / CLIP_CELL), j0 = Math.round(s.z / CLIP_CELL), first = this.step(from, i0 * CLIP_CELL, j0 * CLIP_CELL);
    if (!first) return [];
    push({ i: i0, j: j0, g: 0, f: CLIP_GREED * h(i0, j0), pose: first, parent: null });
    let end = null, expanded = 0;
    while (heap.length && expanded < CLIP_MAX_NODES) {
      yield;
      const n = pop(), k = key(n.i, n.j, n.pose.y);
      if (closed.has(k)) continue;
      closed.add(k); expanded++;
      const d = h(n.i, n.j);
      if (d <= goalReach) {
        const last = this.step(n.pose, g.x, g.z);
        if (last || d <= arrivalRadius) { end = { node: n, last }; break; }
      }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const a = n.i + di, b = n.j + dj, x = a * CLIP_CELL, z = b * CLIP_CELL;
        if (!Navigation.covered(x, z) || avoided(x, z)) continue;
        // A fresh clip can take a few milliseconds in a dense town: room for a pause.
        if (!this.moves.has(key(n.i, n.j, n.pose.y) + '>' + a + ',' + b)) yield;
        const cost = n.g + CLIP_CELL * Math.hypot(di, dj), pose = move(n, a, b);
        if (!pose) continue;
        const kk = key(a, b, pose.y);
        if (closed.has(kk) || (scores.get(kk) ?? Infinity) <= cost) continue;
        scores.set(kk, cost);
        push({ i: a, j: b, g: cost, f: cost + CLIP_GREED * h(a, b), pose, parent: n });
      }
    }
    if (!end) return [];
    const path = [];
    for (let n = end.node; n; n = n.parent) path.unshift(n.pose);
    if (end.last) path.push(end.last);
    // Straight chords where the clipper walks them, as the flat planner smooths.
    const result = [];
    let anchor = from;
    for (let i = 0; i < path.length;) {
      let j = i;
      while (j + 1 < path.length) {
        yield;
        const a = Navigation.local(anchor), b = Navigation.local(path[j + 1]);
        if (Math.hypot(b.x - a.x, b.z - a.z) >= CLIP_MAX_CHORD || !this.chord(anchor, path[j + 1])) break;
        j++;
      }
      const p = path[j];
      result.push({ regionId: p.regionId, x: p.x, y: p.y, z: p.z });
      anchor = p; i = j + 1;
    }
    return result;
  },
};
