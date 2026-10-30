const AUTO_START_SETTLE_MS = 5000;
const AUTO_START_NAV_MS = 20000;
const AUTO_START_GIVE_UP_MS = 120000;
// What the player last chose with Start or Stop, kept per character across reloads. Stops the bot makes by itself
// (a world transition, a reload, a settings load) never change it. Auto-start follows it: a character the player
// stopped stays stopped when it enters the game again.
const RunIntent = {
  key() { return World.charName ? 'run:' + World.charName : ''; },
  stopped() { const key = this.key(); return !!key && Store.get(key, null)?.on === false; },
  set(on) { const key = this.key(); if (key) Store.set(key, { on: !!on, at: Date.now() }); },
};
const AutoStart = {
  armed: true, entry: null, message: '',
  on() { return !!Settings.profile.hunt.autoStart; },
  pending() { return !!this.entry && this.on(); },
  status() {
    if (!this.on()) return 'Off.';
    return this.message || 'Waits for the next time this character enters the game.';
  },
  cancel(reason = '') {
    if (!this.entry) return;
    this.entry = null;
    if (reason) { this.message = reason; Log.info(reason); }
  },
  waiting(entry) {
    const gp = World.gp;
    if (!World.local() || !Array.isArray(gp?.inventory) || gp.inventoryPending) return 'waiting for the character to load.';
    const left = AUTO_START_SETTLE_MS - (now() - entry.at);
    if (left > 0) return 'starting in ' + Math.ceil(left / 1000) + ' s.';
    if (now() - Manual.lastAt < Hunt.cfg().manualPauseS * 1000) return 'waiting for the manual-control pause.';
    const pose = World.pose();
    if (!Navigation.scene && pose && !(pose.regionId & DUNGEON) && now() - entry.at < AUTO_START_NAV_MS) return 'waiting for collision data.';
    return '';
  },
  tick() {
    if (!World.inWorld()) return;
    if (this.armed) { this.armed = false; this.entry = { at: now() }; }
    const entry = this.entry;
    if (!entry) return;
    if (Reconnect.active()) return this.cancel('Auto-start skipped: reconnect is bringing the bot back.');
    if (Hunt.running || Town.trip || WalkBack.active || Travel.active || Trade.run || Alchemy.run || Alchemy.pending || Restock.recording) return this.cancel();
    if (now() - entry.at > AUTO_START_GIVE_UP_MS) return this.cancel('Auto-start gave up: the game did not settle within 2 minutes.');
    if (World.charName && Settings.profileKey !== 'profile:' + World.charName) { this.message = 'Auto-start: waiting for the character settings.'; return; }
    if (!this.on()) { this.entry = null; return; }
    if (RunIntent.stopped()) return this.cancel('Auto-start: you stopped the bot last time, so it stays stopped. Press Start / stop to hunt.');
    if (!Hunt.cfg().center) {
      this.cancel('Auto-start: no hunting spot is saved. Set one in Combat → Hunt area (Training place in the Classic window).');
      return UI.toast(this.message, 'warn', 6000);
    }
    const wait = this.waiting(entry);
    if (wait) {
      this.message = 'Auto-start: ' + wait;
      return;
    }
    this.entry = null;
    if (World.isDead()) {
      if (!Town.autoRevive() && Hunt.cfg().onDeath === 'stop') {
        this.message = 'Auto-start: the character is dead and On death is set to Stop, so the bot was not started.';
        Log.info(this.message); UI.toast(this.message, 'warn', 6000);
        return;
      }
      Hunt.start();
      this.message = Hunt.running ? 'Auto-start: started. The character is dead, so it revives and returns first.' : 'Auto-start: the bot could not start.';
      Log.info(this.message);
      return;
    }
    Controller.resumeHunting('Auto-start');
    this.message = Town.trip ? 'Auto-start: in town. Doing town services, then back to the hunting spot.'
      : WalkBack.active || Travel.active ? 'Auto-start: walking to the hunting spot.'
      : Hunt.running ? 'Auto-start: hunting started at the hunting spot.'
      : 'Auto-start: the bot could not start. ' + (Town.message.startsWith('Town cycle stopped:') ? Town.message : 'Check the log.');
    Log.info(this.message);
  },
};
bus.on('phase', (phase, previous, left) => { if (left) { AutoStart.armed = true; AutoStart.entry = null; } });

// Optional: start again after the bot stopped by itself while the player's last choice was Start (a town trip that
// failed, a walk back that got stuck, a stop on a world transition). It waits two minutes, and two minutes after the
// player's last action in the game, then does what Return & hunt does. Stops the player chose in the settings, the
// safety limits, and a stop without a reason or on a world change right after the player acted (a scroll read or a
// portal taken by hand) are final. The same reason twice within 30 minutes, or a fourth try within an hour, stops for
// good. Leaving the world or changing character forgets it all: reconnect and auto-start own a new entry.
const RETRY_DELAY_MS = 120000, RETRY_SAME_MS = 30 * 60000, RETRY_MAX_PER_HOUR = 3, RETRY_PLAYER_MS = 30000;
const RETRY_FINAL = /^(out of HP potions|inventory full|character died|stuck: no progress|character cannot move|hunt area is in another region)|Recovery town services completed|No saved hunting (spot|point)|save a hunting spot first|manual control/i;
const RETRY_PLAYER_KINDS = new Set(['ground-move', 'move', 'select', 'attack', 'skill', 'pickup', 'cos-attack', 'item-use', 'travel-gate', 'npc-talk']);
const Retry = {
  active: false, reason: '', reasonAt: -Infinity, stop: null, history: [], message: '', playerAt: -Infinity,
  on() { return !!Settings.profile.hunt.retry; },
  status() { return this.on() ? this.message || 'Waits for the bot to stop by itself.' : 'Off.'; },
  reset() { this.active = false; this.stop = null; this.history = []; this.message = ''; this.reasonAt = -Infinity; },
  // The reason a stop gave, kept for the moment the bot goes idle.
  note(reason) { if (reason) { this.reason = String(reason); this.reasonAt = now(); } },
  final(reason) { return RETRY_FINAL.test(String(reason).replace(/^Town cycle stopped: /i, '')); },
  busy() { return !!(Hunt.running || Town.trip || WalkBack.active || Travel.active || Controller.resumeAfterRevive); },
  key(reason) { return String(reason).replace(/\d+/g, '#').trim().toLowerCase(); },
  give(text) { this.message = text; Log.warn(text); UI.toast(text, 'warn', 10000); },
  why(reason) { return reason ? ' (' + reason + ')' : ''; },
  tick() {
    if (this.busy()) { this.active = true; this.stop = null; return; }
    if (this.active) {
      this.active = false;
      const reason = now() - this.reasonAt < 2000 ? this.reason : '';
      if (!this.on() || RunIntent.stopped()) return;
      if (this.final(reason)) { this.message = 'Stopped: ' + reason + '. Not started again: that stop is final.'; return; }
      if ((!reason || reason === 'world change') && now() - this.playerAt < RETRY_PLAYER_MS) { this.message = 'Stopped right after your own action in the game; not started again.'; return; }
      const key = this.key(reason);
      this.history = this.history.filter(h => now() - h.at < 3600000);
      if (this.history.some(h => h.key === key && now() - h.at < RETRY_SAME_MS)) return this.give('The bot stopped again for the same reason' + this.why(reason) + '; not starting it again. Check the character.');
      if (this.history.length >= RETRY_MAX_PER_HOUR) return this.give('The bot stopped by itself ' + (RETRY_MAX_PER_HOUR + 1) + ' times in an hour; not starting it again. Check the character.');
      this.stop = { reason, key, at: now() };
      Log.info('The bot stopped by itself' + this.why(reason) + '; starting again in 2 minutes.');
    }
    const s = this.stop;
    if (!s) return;
    if (!this.on() || RunIntent.stopped()) { this.stop = null; this.message = ''; return; }
    // A reconnect or an auto-start brings the bot back by itself; anything else the player started waits too.
    if (!World.inWorld() || Reconnect.active() || AutoStart.pending() || Alchemy.run || Alchemy.pending || Stall.run || Trade.run || Restock.trip || Restock.recording || Resurrect.trip || BuffGear.run) return;
    const left = Math.max(s.at, Manual.lastAt, this.playerAt) + RETRY_DELAY_MS - now();
    if (left > 0 || !World.local() || World.gp?.inventoryPending) {
      this.message = 'The bot stopped by itself' + this.why(s.reason) + '; starting again in ' + Math.max(1, Math.ceil(left / 1000)) + ' s.';
      return;
    }
    this.stop = null;
    if (World.isDead() && !Town.autoRevive() && Hunt.cfg().onDeath === 'stop') { this.message = 'Not started again: the character is dead and On death is set to Stop.'; return; }
    this.history.push({ key: s.key, at: now() });
    if (World.isDead()) Hunt.start(); else Controller.resumeHunting('Started again');
    this.active = this.busy();
    this.message = this.active ? 'Started again after the bot stopped by itself' + this.why(s.reason) + '.' : 'Could not start again; check the log.';
    Log.info(this.message);
  },
};
{
  const stopHunting = Hunt.stop, cancelWalk = WalkBack.cancel, failTravel = Travel.fail;
  Hunt.stop = function (reason) { if (this.running) Retry.note(reason); return stopHunting.apply(this, arguments); };
  WalkBack.cancel = function (reason) { if (this.active) Retry.note(reason); return cancelWalk.apply(this, arguments); };
  Travel.fail = function (reason) { if (this.active) Retry.note('Travel stopped: ' + reason); return failTravel.apply(this, arguments); };
}
// Registered before the boot handlers, so the reason is noted before their stopAll.
bus.on('phase', (phase, previous, left) => { if (left) Retry.reset(); else if (phase !== 'world') Retry.note('world change'); });
bus.on('character', () => Retry.reset());
Hook.observers.push(command => { if (command?.kind === 'gameplay' && RETRY_PLAYER_KINDS.has(command.command?.kind)) Retry.playerAt = now(); });
