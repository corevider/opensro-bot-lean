// Automatic HP recovery kits for your attack and pickup pets, and HGP recovery potions (pet food) for the attack
// pet's satiety. Both are companion items (types 3/3/1/4 and 3/3/1/9): the game needs the pet named in the
// item-use command, so this sends it explicitly. Player potions always go first, nothing is resent until the
// previous one is seen to be consumed, and a pet is left alone — 30 s when an item is not seen consumed, 5 min
// when confirmed kits never raise its HP — instead of burning supplies on a bad HP reading.
const PetPotion = {
  maxHp: null, loading: null, retryAt: 0, pending: null, settled: null, blocked: new Map(), stale: new Map(), lastAt: -Infinity,
  feedPending: null, feedBlocked: new Map(), feedLastAt: -Infinity, message: 'Pet potions off.',
  cfg() { return Settings.profile.potion.petHp; },
  hgpCfg() { return Settings.profile.potion.petHgp; },
  reset() {
    this.pending = null; this.settled = null; this.blocked.clear(); this.stale.clear(); this.lastAt = -Infinity;
    this.feedPending = null; this.feedBlocked.clear(); this.feedLastAt = -Infinity;
    this.message = this.cfg().on || this.hgpCfg().on ? 'Waiting for a pet.' : 'Pet potions off.';
  },
  kits() { return World.items().filter(i => Number.isInteger(i.typeFlags) && ItemType.potionCategory(i.typeFlags) === 4 && (i.quantity ?? 1) > 0); },
  total(ref) { return this.kits().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  heal(item) { return Number(item.tooltip?.fields?.itemParam1_29c) || 0; },
  // The server scales a kit's flat heal by the owner's strength and level — (strength/416 + 1) * 1.02^(level-1) * base —
  // so a small kit covers far more than its tooltip value. Without the estimate the picker takes the biggest kit.
  healEstimate(item) {
    const base = this.heal(item), s = World.gp?.progression?.stats, level = World.gp?.progression?.level;
    if (!base || !Number.isFinite(s?.strength) || !Number.isInteger(level) || level < 1) return base;
    return Math.max(base, Math.floor((s.strength / 416 + 1) * Math.pow(1.02, level - 1) * base));
  },
  foods() { return World.items().filter(i => Number.isInteger(i.typeFlags) && ItemType.potionCategory(i.typeFlags) === 9 && (i.quantity ?? 1) > 0); },
  foodTotal(ref) { return this.foods().filter(i => i.refObjId === ref).reduce((n, i) => n + (i.quantity ?? 1), 0); },
  foodPct(item) { return Number(item.tooltip?.fields?.itemParam1_29c) || 0; },
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
  // Satiety runs 0..10000 and only attack pets (band 3) carry it; the record is the live source, so no
  // catalogue is needed here.
  hungerPets() {
    const out = [];
    for (const rec of World.gp?.cosRecords || []) {
      if (!rec || rec.dead || !(rec.hp > 0) || rec.band !== 3 || !Number.isInteger(rec.gid) || rec.gid <= 0 || !Number.isFinite(rec.satiety)) continue;
      out.push({ gid: rec.gid, satiety: rec.satiety, pct: rec.satiety / 100 });
    }
    return out;
  },
  // Smallest kit whose estimated heal covers the missing HP, otherwise the biggest one.
  pick(missing) {
    const kits = this.kits().sort((a, b) => this.heal(a) - this.heal(b));
    return kits.find(k => this.healEstimate(k) >= missing) || kits[kits.length - 1] || null;
  },
  // Smallest food whose percentage covers the missing satiety, otherwise the biggest one.
  pickFood(missing) {
    const foods = this.foods().sort((a, b) => this.foodPct(a) - this.foodPct(b));
    return foods.find(f => this.foodPct(f) * 100 >= missing) || foods[foods.length - 1] || null;
  },
  tick() {
    const P = Settings.profile.potion;
    if ((!this.cfg().on && !this.hgpCfg().on) || !P.enabled) { this.pending = null; this.settled = null; this.feedPending = null; this.message = 'Pet potions off.'; return false; }
    if (!World.inWorld() || World.isDead()) return false;
    this.load();
    const healed = this.healTick();
    if (healed || this.pending) return healed;
    return this.feedTick();
  },
  healTick() {
    const c = this.cfg();
    if (!c.on) return false;
    const p = this.pending;
    if (p) {
      if (this.total(p.ref) < p.before) {
        Activity.emit({ category: 'potion', code: 'pet-kit-consumed', text: 'Pet recovery kit consumption observed in inventory.', outcome: 'confirmed', details: { quantity: 1 } });
        this.pending = null;
        // The stack shrinking and the HP update (0x33A6) are separate messages, so the heal can land a
        // snapshot later: hold the flat judgement for a short grace before counting it.
        this.settled = { gid: p.gid, hp: p.hp, at: now() };
      }
      else if (now() - p.at > 5000) { this.pending = null; this.blocked.set(p.gid, now() + 30000); this.message = 'Pet recovery kit consumption unconfirmed; waiting 30 s.'; }
      else return false;
    }
    if (this.settled) {
      const s = this.settled, flat = this.petHp(s.gid);
      if (!Number.isFinite(flat) || flat !== s.hp) { this.stale.delete(s.gid); this.settled = null; }
      else if (now() - s.at > 1500) {
        this.settled = null;
        // The server consumes a kit even on a full pet, so a confirmed kit whose HP never moved means the
        // reading is wrong; three in a row rest the pet instead of draining the stack.
        const count = (this.stale.get(s.gid)?.count ?? 0) + 1;
        if (count >= 3) {
          this.blocked.set(s.gid, now() + 300000); this.stale.delete(s.gid);
          this.message = 'Confirmed kits never raise this pet HP; waiting 5 min.';
          Activity.emit({ category: 'potion', code: 'pet-kit-flat', text: 'Three confirmed kits left the pet HP untouched; the HP reading looks wrong, resting the pet 5 min.', outcome: 'refused', details: { gid: s.gid, hp: flat } });
          return false;
        }
        this.stale.set(s.gid, { count });
      }
      else return false;
    }
    if (World.gp.inventoryPending || now() - this.lastAt < 1500 || now() - Potion.lastUse < Settings.profile.potion.delayMs) return false;
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
  // HGP recovery potions (pet food) restore a percentage of the 10000 satiety gauge; the server refuses — without
  // consuming — above 99%, so the setting stays at or below 95. The gauge is exact, so no flat-reading guard is
  // needed: an unseen consumption already rests the pet for 30 s.
  feedTick() {
    const c = this.hgpCfg();
    if (!c.on) return false;
    const p = this.feedPending;
    if (p) {
      if (this.foodTotal(p.ref) < p.before) {
        Activity.emit({ category: 'potion', code: 'pet-food-consumed', text: 'Pet HGP potion consumption observed in inventory.', outcome: 'confirmed', details: { quantity: 1 } });
        this.feedPending = null;
      }
      else if (now() - p.at > 5000) { this.feedPending = null; this.feedBlocked.set(p.gid, now() + 30000); this.message = 'Pet HGP potion consumption unconfirmed; waiting 30 s.'; }
      else return false;
    }
    if (World.gp.inventoryPending || now() - this.feedLastAt < 1500 || now() - Potion.lastUse < Settings.profile.potion.delayMs) return false;
    const pets = this.hungerPets().filter(x => (this.feedBlocked.get(x.gid) ?? 0) <= now()).sort((a, b) => a.pct - b.pct);
    if (!pets.length) {
      if (World.gp?.cosRecords?.some(r => r && !r.dead && r.hp > 0 && r.band === 3 && !Number.isFinite(r.satiety))) this.message = 'Waiting for pet HGP data.';
      return false;
    }
    const pet = pets[0];
    if (pet.pct > c.pct) return false;
    const food = this.pickFood(10000 - pet.satiety);
    if (!food) { this.message = 'Pet is hungry but no HGP recovery potions in the bag.'; return false; }
    if (!Cmd.itemUseOnPet(food.slot, pet.gid)) return false;
    this.feedPending = { ref: food.refObjId, before: this.foodTotal(food.refObjId), gid: pet.gid, at: now() }; this.feedLastAt = now();
    this.message = 'HGP recovery potion requested for the pet at ' + Math.round(pet.pct) + '% satiety; waiting for consumption confirmation.';
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
