// Teleporters and ferries for a walk that cannot be made on foot (lean-travel-data.js). The route areas
// (lean-route.js) say where walking connects; a teleport or ferry link joins two places for its fee. Every walk
// between them is still a WalkBack walk, and each hop is the game's own portal menu: select the teleporter, wait for
// its menu, send travel-gate type 2 with the destination's teleport id, and confirm the arrival.
const TRAVEL_HOP = 3000;        // a hop (menu and load screen) weighs like this much walking
const TRAVEL_WALK = 1.3;        // a walk is longer than the straight line
const TRAVEL_REACH = 150;       // stop this close to the teleporter: it stands on a dock or a ship; the game talks within 20 m
const TRAVEL_FIND = 300;        // the teleporter stands within this of its table position
const TRAVEL_STEP_MS = 15000;   // selecting, the menu, and the hop starting
const TRAVEL_ARRIVE_MS = 90000;
const TRAVEL_LAND = 900;        // the arrival lands within this of the destination teleporter
const TRAVEL_REPLANS = 3;
const TRAVEL_PORTAL = 0x80;     // target capability: the teleport menu

const Travel = {
  active: null, message: '', places: null,
  on() { return Settings.profile.hunt.travel !== false; },
  // Teleporters with a known position. Town world statues are buildings: their position comes from the town table.
  nodes() {
    if (this.places) return this.places;
    const gates = new Map((typeof TOWN_TABLE !== 'undefined' ? TOWN_TABLE : []).map(t => [t.services.gate?.refObjId, { town: t.name, ...t.services.gate }]));
    this.places = new Map();
    for (const row of typeof TRAVEL_TABLE !== 'undefined' ? TRAVEL_TABLE.nodes : []) {
      const gate = gates.get(row.refObjId), at = Number.isInteger(row.regionId) ? row : gate;
      if (!at) continue;
      this.places.set(row.id, { id: row.id, refObjId: row.refObjId, label: gate ? 'the ' + gate.town + ' world statue' : 'the teleporter',
        pose: { regionId: at.regionId, x: at.x, y: at.y, z: at.z } });
    }
    return this.places;
  },
  links() { return typeof TRAVEL_TABLE !== 'undefined' ? TRAVEL_TABLE.links : []; },
  walkable(a, b) {
    const d = dist2D(a, b);
    return Number.isFinite(d) && (d <= WALK_LEG || !!Route.commonArea(a, b));
  },
  // Cheapest mix of walks and hops (Dijkstra over the start, the goal and every teleporter). Steps alternate between
  // { kind: 'walk', to } and { kind: 'hop', from, to, fee }; null when no mix reaches the goal.
  plan(from, to, banned = new Set()) {
    if (!from || !to || ((from.regionId | to.regionId) & DUNGEON)) return null;
    const nodes = [...this.nodes().values()], gold = toBigInt(World.gp?.progression?.gold ?? 0);
    const points = [{ pose: from }, { pose: to }, ...nodes.map(node => ({ pose: node.pose, node }))];
    const index = new Map(nodes.map((node, i) => [node.id, i + 2])), hops = new Map();
    for (const [source, destination, fee] of this.links()) {
      if (!index.has(source) || !index.has(destination) || banned.has(source + '>' + destination) || BigInt(fee) > gold) continue;
      if (!hops.has(source)) hops.set(source, []);
      hops.get(source).push({ destination, fee });
    }
    const cost = points.map(() => Infinity), came = [], done = [];
    cost[0] = 0;
    for (;;) {
      let i = -1;
      for (let j = 0; j < points.length; j++) if (!done[j] && cost[j] < Infinity && (i < 0 || cost[j] < cost[i])) i = j;
      if (i < 0 || i === 1) break;
      done[i] = true;
      const relax = (j, value, step) => { if (value < cost[j]) { cost[j] = value; came[j] = { from: i, step }; } };
      for (let j = 1; j < points.length; j++) {
        if (j !== i && !done[j] && this.walkable(points[i].pose, points[j].pose)) relax(j, cost[i] + dist2D(points[i].pose, points[j].pose) * TRAVEL_WALK, { kind: 'walk' });
      }
      for (const hop of points[i].node ? hops.get(points[i].node.id) || [] : []) {
        const j = index.get(hop.destination);
        relax(j, cost[i] + TRAVEL_HOP + hop.fee, { kind: 'hop', fee: hop.fee });
      }
    }
    if (cost[1] === Infinity) return null;
    const steps = [];
    for (let j = 1; j !== 0; j = came[j].from) {
      const step = came[j].step;
      steps.unshift(step.kind === 'walk' ? { kind: 'walk', to: points[j].pose, node: points[j].node || null }
        : { kind: 'hop', from: points[came[j].from].node, to: points[j].node, fee: step.fee });
    }
    return steps;
  },
  // WalkBack asks first: true when the walk needs a teleport or a ferry and the trip has started here instead.
  begin(pose, dest, resume) {
    if (!this.on() || !Number.isFinite(dist2D(pose, dest)) || this.walkable(pose, dest)) return false;
    const steps = this.plan(pose, dest);
    if (!steps?.some(s => s.kind === 'hop')) return false;
    this.active = { dest: { ...dest }, resume, steps, index: 0, phase: '', at: now(), banned: new Set(), replans: 0, manualAt: Manual.lastAt };
    const hops = steps.filter(s => s.kind === 'hop'), fees = hops.reduce((n, s) => n + s.fee, 0);
    Log.info('Travel: the hunting spot needs ' + hops.length + ' teleport' + (hops.length === 1 ? '' : 's') + ' or ferr' + (hops.length === 1 ? 'y' : 'ies') + (fees ? ' (' + fees + ' gold)' : '') + '.');
    this.next();
    return true;
  },
  next() {
    const a = this.active, step = a?.steps[a.index];
    if (!a) return;
    if (!step) {
      this.active = null; this.message = 'Back at the hunting spot.';
      UI.toast(this.message, 'info', 2500);
      if (a.resume) Hunt.start();
      return;
    }
    a.phase = step.kind === 'walk' ? 'walk' : 'select'; a.at = now(); a.gid = 0; a.talked = false; a.transition = false; a.refused = '';
    if (step.kind === 'hop') { this.message = 'Travel: using ' + step.from.label + (step.fee ? ' (' + step.fee + ' gold).' : '.'); return; }
    const last = a.index === a.steps.length - 1, label = last ? 'the hunting spot' : step.node?.label || 'the teleporter';
    this.message = 'Travel: walking to ' + label + '.';
    WalkBack.startTo(step.to, { label, stop: last ? 12 : TRAVEL_REACH,
      onDone: () => { if (this.active === a) { a.index++; this.next(); } },
      onFail: reason => { if (this.active === a) this.fail(reason); } });
    if (this.active === a && !WalkBack.active) this.fail('the walk to ' + label + ' did not start');
  },
  entity(node) {
    return [...World.ents.values()].find(e => (e.kind === 'npc' || e.kind === 'teleport') && e.refObjId === node.refObjId && dist2D(e, node.pose) <= TRAVEL_FIND);
  },
  tick() {
    const a = this.active;
    if (!a || a.phase === 'walk' || !World.inWorld()) return;
    if (Manual.lastAt !== a.manualAt) return this.fail('manual control');
    if (World.isDead()) return this.fail('the character died');
    const step = a.steps[a.index], gp = World.gp;
    if (a.phase === 'select') {
      if (now() - a.at > TRAVEL_STEP_MS) return this.fail(step.from.label + ' could not be selected');
      const npc = this.entity(step.from);
      if (!npc || gp.targetPending || gp.inventoryPending) return;
      if (gp.target !== npc.gid) { if (Cmd.spaced('select')) Cmd.select(npc.gid); return; }
      if (!(gp.targetCapabilities & TRAVEL_PORTAL)) return this.fail(step.from.label + ' offers no teleport');
      a.gid = npc.gid; a.phase = 'menu'; a.at = now();
    }
    if (a.phase === 'menu') {
      if (gp.target !== a.gid) return this.fail('the teleporter selection changed');
      if (!(gp.npcConversation?.phase === 'menu' && gp.npcConversation.gid === a.gid)) {
        if (!a.talked && now() - a.at > 2000 && Cmd.raw({ kind: 'npc-talk' }, 'Travel: open the teleport menu')) a.talked = true;
        if (now() - a.at > TRAVEL_STEP_MS) this.fail('the teleport menu did not open');
        return;
      }
      if (BigInt(step.fee) > toBigInt(gp.progression?.gold ?? 0)) return this.fail('not enough gold for the ' + step.fee + ' gold fee');
      if (Cmd.raw({ kind: 'travel-gate', gid: a.gid, type: 2, target: step.to.id }, 'Travel: ' + step.from.label + ' to teleport ' + step.to.id)) {
        a.phase = 'arrive'; a.at = now(); a.refused = ''; a.landedAt = 0;
        Log.info('Travel: taking ' + step.from.label + (step.fee ? ' (' + step.fee + ' gold).' : '.'));
      }
      return;
    }
    if (a.phase === 'arrive') {
      if (a.refused || !a.transition && now() - a.at > TRAVEL_STEP_MS) return this.refused(step, a.refused);
      if (now() - a.at > TRAVEL_ARRIVE_MS) return this.fail('the arrival timed out');
      if (!a.transition || !World.local() || gp.inventoryPending) return;
      // The landing is usually beside the destination teleporter; a settled landing elsewhere still walks on from there.
      a.landedAt ||= now();
      if (dist2D(World.pose(), step.to.pose) <= TRAVEL_LAND || now() - a.landedAt > 5000) { a.index++; this.next(); }
    }
  },
  // A refused hop (fee, level, trade cart...) is left out and the rest is planned again from here.
  refused(step, key) {
    const a = this.active;
    a.banned.add(step.from.id + '>' + step.to.id);
    const why = /NOT_ENOUGH_MONEY/.test(key) ? 'not enough gold' : /LEVEL/.test(key) ? 'level too low' : key ? 'refused by the game' : 'no answer from the game';
    Log.warn('Travel: ' + step.from.label + ' did not take you (' + why + ').');
    const steps = a.replans < TRAVEL_REPLANS ? this.plan(World.pose(), a.dest, a.banned) : null;
    if (!steps) return this.fail(step.from.label + ': ' + why);
    a.replans++; a.steps = steps; a.index = 0;
    if (Cmd.raw({ kind: 'npc-close' }, 'Travel: close the teleport menu')) this.next(); else this.fail('the teleport menu did not close');
  },
  notice(n) {
    const a = this.active;
    if (a && !a.transition && a.phase === 'arrive' && /INTERACTION_FAIL|TELEPORT/.test(String(n?.key || ''))) a.refused = String(n.key);
  },
  // The hop's own load screen is expected; any other world change ends the trip (lean-boot.js).
  phase(phase) {
    const a = this.active;
    if (!a) return false;
    if (phase === 'entering-world' && a.phase === 'arrive' && !a.refused && now() - a.at < TRAVEL_ARRIVE_MS) { a.transition = true; return true; }
    this.fail('unexpected travel or disconnect');
    return false;
  },
  fail(reason) {
    if (!this.active) return;
    this.active = null;
    WalkBack.cancel('', false);
    this.message = 'Travel stopped: ' + reason + '.';
    Log.warn(this.message); UI.toast(this.message, 'warn', 6000);
  },
  cancel() { this.active = null; },
  status() { return this.active ? this.message : ''; },
};
bus.on('notice', n => Travel.notice(n));
