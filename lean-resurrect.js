// Auto-resurrect dead party members with a learned corpse-targeted skill.
// The sim worker replaces a skill press's gid with the newest selection intent
// (core.ts), so the corpse is selected immediately before the press. The server
// proposes the revival, which the dead member answers inside a 30 second window.
// Only in-range corpses are considered when authored range is available.
// After a teleport or walking back into view the game can draw a dead player standing. The party list (HP in tenths)
// then still says 0, so a standing member at 0 counts as dead unless the server's own HP for the body says otherwise
// (sent when a player comes into view). The server does not send HP for a selected player, so it decides by taking or
// refusing the Rebirth; a refusal (nearly dead, not dead) waits for the answer window like an unanswered offer.
const RES_ALIVE_MS = 30000; // a standing member the server reports alive is checked again after this
const Resurrect = {
  sent: {},           // member id -> time of the unanswered proposal
  checked: {},        // member id -> time until which a standing member counts as alive
  nextAt: -Infinity,  // earliest next attempt
  holdUntil: 0,
  trip: null,
  windowMs: 31000,    // the server's answer window plus one tick
  message: 'No fallen party member.',
  reset() { this.cancelTrip('', true); this.sent = {}; this.checked = {}; this.nextAt = -Infinity; this.holdUntil = 0; this.message = 'No fallen party member.'; },
  // Whether a party member at 0 HP in the party list is dead: a corpse, or a standing body without known HP above 0.
  dead(e) {
    if (e.appearanceState?.[0] === 2) return true;
    const hp = World.hpOf(e.gid);
    return !isNum(hp) || hp === 0;
  },
  cancelTrip(message = '', halt = false) {
    if (this.trip && halt && this.trip.phase === 'approach') this.sent[this.trip.member] = now();
    if (this.trip && halt && World.inWorld() && !World.isDead()) Cmd.move(World.pose());
    this.trip = null;
    if (message) { this.message = message; Log.warn(message); }
  },
  returnTrip(message = '') {
    const a = this.trip;
    if (!a) return;
    a.phase = 'return'; a.travel = null; a.at = a.progressAt = now(); a.lastPose = { ...World.pose() }; a.sentAt = -Infinity;
    this.message = message || 'Returning to the hunting spot after resurrection.';
    if (message) Log.info(message);
  },
  travelTick(skill, members) {
    const a = this.trip, pose = World.pose();
    if (!a || !pose) return false;
    const member = members.find(m => m.id === a.member && m.name === a.name);
    const body = World.ents.get(a.gid);
    if (a.phase === 'cast') this.returnTrip();
    if (a.phase === 'approach' && (!member || (member.status & 15) !== 0 || !body || body.name !== a.name || !this.dead(body) ||
        !Number.isFinite(dist2D(a.home, body)) || dist2D(a.home, body) > Settings.profile.party.resRadius)) {
      this.returnTrip('Resurrection target unavailable or outside the configured radius; returning.');
    }
    if (dist2D(a.lastPose, pose) > 3) { a.lastPose = { ...pose }; a.progressAt = now(); }
    if (now() - a.at > 30000 || now() - a.progressAt > 12000) {
      if (a.phase === 'approach') {
        this.sent[a.member] = now() + 30000;
        this.returnTrip('Resurrection travel timed out; returning to the hunting spot.');
      } else {
        this.cancelTrip('Resurrection return blocked or timed out.', true);
        if (Hunt.running) Hunt.stop('Resurrection return blocked or timed out.');
        return false;
      }
    }
    const destination = a.phase === 'return' ? a.home : body;
    const distance = dist2D(pose, destination);
    if (a.phase === 'return' && distance <= 12) { this.trip = null; this.message = 'Back at the hunting spot.'; return false; }
    if (a.phase === 'approach' && distance <= Math.max(1, (skill.range || 150) - 5)) return false;
    if (World.isCasting() || World.isSitting()) return true;
    const move = Navigation.next(a, destination);
    if (move.error && !move.waiting) {
      if (a.phase === 'approach') {
        this.sent[a.member] = now() + 30000;
        this.returnTrip('No walkable route to the party member; returning.');
      } else {
        this.cancelTrip(move.error, true);
        if (Hunt.running) Hunt.stop(move.error);
      }
      return true;
    }
    if (move.waiting) { this.message = move.error || 'Waiting for resurrection travel.'; return true; }
    if (a.phase === 'approach' && dist2D(a.home, move.point) > Math.max(Settings.profile.party.resRadius, dist2D(a.home, pose) + 1)) {
      this.sent[a.member] = now() + 30000; this.returnTrip('Resurrection detour exceeds the configured radius; returning.'); return true;
    }
    if (now() - a.sentAt >= 900 && Cmd.move(move.point)) a.sentAt = now();
    this.message = a.phase === 'return' ? 'Returning to the hunting spot.' : 'Walking into resurrection range: ' + a.name;
    return true;
  },
  // The highest-tier learned corpse-targeted row: the Rebirth family marks
  // itself with the DeadBody target bit, and later tiers carry the higher
  // mastery requirement.
  skill() {
    let best = null;
    for (const id of World.gp?.skills || []) {
      const s = World.skill(id);
      if (!s || !s.targetRequired || !((s.targets ?? 0) & 128)) continue;
      if (!best || this.rank(s) > this.rank(best)) best = s;
    }
    return best;
  },
  rank(s) {
    const mastery = Math.max(0, ...(s.masteries || []).map(m => m.Level || 0));
    return mastery * 1000 + (s.level ?? 0);
  },
  tick() {
    const c = Settings.profile.party;
    if (!c.autoRes) { this.cancelTrip('', true); this.holdUntil = 0; this.message = 'Auto-resurrect off.'; return false; }
    if (!World.inWorld() || World.isDead()) { this.cancelTrip(); this.holdUntil = 0; this.message = 'Waiting for a living character.'; return false; }
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) { this.cancelTrip('Manual control: resurrection travel cancelled.'); this.holdUntil = 0; return false; }
    if (now() < this.holdUntil || this.holdUntil && World.isCasting()) return true;
    this.holdUntil = 0;
    const social = World.gp?.social, members = social?.members;
    if (!Array.isArray(members)) { this.cancelTrip('', true); return false; }
    const party = members.filter(m => m && m.id && m.name && m.name !== social.localName);
    const t = now();
    for (const list of [this.sent, this.checked]) for (const id of Object.keys(list)) {
      const m = party.find(x => x.id === Number(id));
      if (!m || (m.status & 15) !== 0) delete list[id];
    }
    const offered = party.find(m => this.sent[m.id]);
    this.message = offered ? 'Resurrection offered: ' + offered.name + '; waiting for the answer.' : 'Watching for fallen party members.';
    const skill = this.skill();
    if (!skill) { this.cancelTrip('', true); this.message = 'No learned resurrection skill (Rebirth) was found.'; return; }
    if (this.trip && this.travelTick(skill, party)) return true;
    if (t < this.nextAt || World.gp.targetPending || !Cmd.canCast(skill.id)) return !!this.trip;
    if (World.isCasting() || World.isSitting() || World.local()?.mountedOn || World.gp.inventoryPending ||
        now() - Combat.lastCastAt < Settings.profile.macro.castGapMs || !Combat.mpOk(skill.id, World.me())) return !!this.trip;
    for (const m of party) {
      if ((m.status & 15) !== 0 || this.sent[m.id] && t - this.sent[m.id] < this.windowMs || this.checked[m.id] > t) continue;
      // The corpse must be in view as an entity to aim the select at.
      const e = [...World.ents.values()].find(x => x && x.kind === 'player' && x.name === m.name);
      if (!e) continue;
      if (!this.dead(e)) { this.checked[m.id] = t + RES_ALIVE_MS; continue; }
      if (this.trip && e.gid !== this.trip.gid) continue;
      const distance = dist2D(World.pose(), e);
      const home = this.trip?.home || (Hunt.running && Settings.profile.hunt.center) || World.pose();
      if (!Number.isFinite(distance) || dist2D(home, e) > c.resRadius) continue;
      if (e.appearanceState?.[0] !== 2 && this.sent[m.id] === undefined) Log.info(m.name + ' is at 0 HP in the party list but shown standing; offering resurrection.');
      if (Loot.active && !Loot.active.petGid) {
        if (!Cmd.move(World.pose())) return false;
        Loot.suspend();
      }
      if (distance > Math.max(1, (skill.range || 150) - 5)) {
        if (!this.trip) this.trip = { phase: 'approach', member: m.id, gid: e.gid, name: e.name, home: { ...home },
          at: t, progressAt: t, lastPose: { ...World.pose() }, sentAt: -Infinity };
        return this.travelTick(skill, party);
      }
      if (!Cmd.select(e.gid)) return !!this.trip;
      if (!Cmd.skill(skill.id, e.gid)) return !!this.trip;
      if (this.trip) this.trip.phase = 'cast';
      Combat.lastCastAt = t; Combat.lastCastId = skill.id; Stats.count('casts');
      // Keep combat/loot movement from replacing the approach or cast before
      // the worker has published it. Continue holding any observed cast.
      this.holdUntil = t + Math.max(1000, skill.actionMs || 6000) + 500;
      this.nextAt = t + 700;
      const first = this.sent[m.id] === undefined;
      this.sent[m.id] = t;
      this.message = 'Resurrection offered: ' + m.name + '; waiting for the answer.';
      if (first) UI.toast('Resurrection offered: ' + m.name, 'info', 3000);
      return true;
    }
  },
};
