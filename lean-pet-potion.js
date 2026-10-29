// Automatic HP recovery kits for your attack and pickup pets. Kits are companion items (type 3/3/1/4): the game
// needs the pet named in the item-use command, so this sends it explicitly. Player potions always go first, kits
// are never resent until the previous one is seen to be consumed, and a pet is left alone — 30 s when a kit is
// not seen consumed, 5 min when confirmed kits never raise its HP — instead of burning kits on a bad HP reading.
const PetPotion = {
  maxHp: null, loading: null, retryAt: 0, pending: null, blocked: new Map(), stale: new Map(), lastAt: -Infinity, message: 'Pet potions off.',
  cfg() { return Settings.profile.potion.petHp; },
  reset() { this.pending = null; this.blocked.clear(); this.stale.clear(); this.lastAt = -Infinity; this.message = this.cfg().on ? 'Waiting for a pet.' : 'Pet potions off.'; },
  kits() { return World.items().filter(i => Number.isInteger(i.typeFlags) && ItemType.potionCategory(i.typeFlags) === 4 && (i.quantity ?? 1) > 0); },
  total(ref) { return this.kits().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  heal(item) { return Number(item.tooltip?.fields?.itemParam1_29c) || 0; },
  // The catalogue is the only maximum source, exactly like the game's own pet window; vitals rows for a COS
  // never carry a maintained maximum.
  async load() {
    if (this.maxHp || this.loading || now() < this.retryAt || !W.location?.origin) return;
    this.retryAt = now() + 30000;
    this.loading = Icons.request('/assets/data/cosPresentation.json', 'json').then(data => {
      const rows = data?.rows;
      if (!rows || typeof rows !== 'object') throw Error('Invalid pet catalogue');
      this.maxHp = new Map(Object.entries(rows).filter(([, row]) => Array.isArray(row) && Number.isInteger(row[1]) && row[1] > 0).map(([id, row]) => [Number(id), row[1]]));
    }).catch(() => {}).finally(() => { this.loading = null; });
    return this.loading;
  },
  // Living attack (band 3) and pickup (band 4) pets with their HP as a percentage; unknown maximums are skipped.
  pets() {
    const out = [];
    for (const rec of World.gp?.cosRecords || []) {
      if (!rec || rec.dead || !(rec.hp > 0) || (rec.band !== 3 && rec.band !== 4) || !Number.isInteger(rec.gid) || rec.gid <= 0) continue;
      const max = this.maxHp?.get(rec.refObjId);
      if (!(max > 0)) continue;
      const vital = World.vitalsOf(rec.gid), hp = Number.isFinite(vital?.hp) ? vital.hp : rec.hp;
      out.push({ gid: rec.gid, hp, max, pct: hp / max * 100 });
    }
    return out;
  },
  petHp(gid) {
    const vital = World.vitalsOf(gid);
    if (Number.isFinite(vital?.hp)) return vital.hp;
    const rec = World.gp?.cosRecords?.find(r => r && r.gid === gid);
    return Number.isFinite(rec?.hp) ? rec.hp : undefined;
  },
  // Smallest kit that covers the missing HP, otherwise the biggest one.
  pick(missing) {
    const kits = this.kits().sort((a, b) => this.heal(a) - this.heal(b));
    return kits.find(k => this.heal(k) >= missing) || kits[kits.length - 1] || null;
  },
  tick() {
    const c = this.cfg(), P = Settings.profile.potion;
    if (!c.on || !P.enabled) { this.pending = null; this.message = 'Pet potions off.'; return false; }
    if (!World.inWorld() || World.isDead()) return false;
    this.load();
    const p = this.pending;
    if (p) {
      if (this.total(p.ref) < p.before) {
        Activity.emit({ category: 'potion', code: 'pet-kit-consumed', text: 'Pet recovery kit consumption observed in inventory.', outcome: 'confirmed', details: { quantity: 1 } });
        this.pending = null;
        // The server consumes a kit even on a full pet, so a confirmed kit whose HP does not move means the
        // reading is wrong; three in a row rest the pet instead of draining the stack.
        const flat = this.petHp(p.gid), mark = this.stale.get(p.gid);
        if (Number.isFinite(flat) && flat === p.hp) {
          const count = (mark?.count ?? 0) + 1;
          if (count >= 3) { this.blocked.set(p.gid, now() + 300000); this.stale.delete(p.gid); this.message = 'Confirmed kits never raise this pet HP; waiting 5 min.'; return false; }
          this.stale.set(p.gid, { count });
        }
        else this.stale.delete(p.gid);
      }
      else if (now() - p.at > 5000) { this.pending = null; this.blocked.set(p.gid, now() + 30000); this.message = 'Pet recovery kit consumption unconfirmed; waiting 30 s.'; }
      else return false;
    }
    if (World.gp.inventoryPending || now() - this.lastAt < 1500 || now() - Potion.lastUse < P.delayMs) return false;
    const known = this.pets(), pets = known.filter(x => (this.blocked.get(x.gid) ?? 0) <= now()).sort((a, b) => a.pct - b.pct);
    for (const x of known) if (x.pct > c.pct) this.stale.delete(x.gid);
    if (known.length && !pets.length) return false;
    if (!pets.length) { this.message = World.gp?.cosRecords?.some(r => r && !r.dead && r.hp > 0 && (r.band === 3 || r.band === 4)) ? 'Waiting for pet HP data.' : 'No attack or pickup pet to heal.'; return false; }
    const pet = pets[0];
    if (pet.pct > c.pct) { this.message = 'Pet HP ' + Math.round(pet.pct) + '%; heals at ' + c.pct + '%.'; return false; }
    const kit = this.pick(pet.max - pet.hp);
    if (!kit) { this.message = 'Pet HP low but no pet recovery kits in the bag.'; return false; }
    if (!Cmd.itemUseOnPet(kit.slot, pet.gid)) return false;
    this.pending = { ref: kit.refObjId, before: this.total(kit.refObjId), gid: pet.gid, hp: pet.hp, at: now() }; this.lastAt = now();
    this.message = 'Recovery kit requested for the pet at ' + Math.round(pet.pct) + '% HP; waiting for consumption confirmation.';
    return true;
  },
};
// The game requires the pet in the command; the compact command layer only sends untargeted item uses.
Cmd.itemUseOnPet = function (slot, gid) {
  const gp = World.gp, item = gp?.inventory?.find(i => i.slot === slot);
  if (!item || gp.inventoryPending || World.isDead() || !this.spaced('item-use') || ItemType.useTarget((item.typeFlags ?? 0) >>> 0) !== 'companion') return false;
  if (!gp.cosRecords?.some(r => r && r.gid === gid && !r.dead && r.hp > 0)) return false;
  return this.raw({ kind: 'item-use', slot, companionGid: gid }, 'Use on pet: ' + (item.name || item.refObjId));
};
// Player potions keep their priority: the pet kit is only considered when none was used this tick.
const playerPotionTick = Potion.tick;
Potion.tick = function () {
  const before = this.lastUse;
  playerPotionTick.apply(this, arguments);
  if (this.lastUse === before) Controller.guard('Pet potions', () => PetPotion.tick());
};
