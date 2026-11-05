// Referral cards (version 1.14.0; counter tablet 1.16.0; names required 1.16.1): the no-sign-in demo, ?demo=1 on this computer
// (localhost) only; ?demo=1&owner=1 acts as the owner. Made-up people and 555 numbers in memory, with the same
// functions as referral-data.js and the same rules as supabase_referral.sql and supabase_referral_tiers.sql
// (the database's error messages too). Nothing is read from or saved to Supabase; a reload starts over.
import {
  normalizePhone, redeemCheck, handoutCheck, chainOf, hotelCounts, addDays, cardLabel, signupList, personalRows,
  pizzaPlan, LUNCH_EVERY, UNDO_REFUSED, shortDay, formatPhone, checkFullName, cleanName,
} from './referral-logic.js';

export const DEMO_ME = 'demo-me';
const PEOPLE = { 'demo-me': 'Demo', 'demo-maria': 'Maria', 'demo-owner': 'Owner' };

export function makeDemoStore(today, { owner = false } = {}) {
  let seq = 1;
  const batches = [];
  const cards = [];
  const reds = [];
  const rewards = [];
  const lunches = [];
  // who is typing, and on which store day (the seed below types in past days as other people)
  const ctx = { by: owner ? 'demo-owner' : DEMO_ME, day: today };
  const me = ctx.by;
  const stamp = () => ({ created_by: ctx.by, by_name: PEOPLE[ctx.by], created_at: `${ctx.day}T12:00:00.${String(seq++).padStart(6, '0')}Z`, created_on: ctx.day });

  const fail = (msg) => { throw new Error(msg); };
  const cardOf = (n) => cards.find((c) => c.card_no === n) || null;
  const withBatch = (c) => (c ? { ...c, batch: c.batch_id ? batches.find((b) => b.id === c.batch_id) : null } : null);
  const isOwner = () => ctx.by === 'demo-owner';

  // referral_sync_reward: the breadsticks for one redeemed card
  function syncReward(n) {
    const c = cardOf(n);
    const r = reds.find((x) => x.card_no === n);
    const i = rewards.findIndex((x) => x.earned_from_card === n && x.kind === 'breadsticks');
    if (!r || !c || c.batch_id || !c.referrer_phone || c.referrer_phone === r.new_phone) {
      if (i >= 0 && !rewards[i].given_on) rewards.splice(i, 1);
      return;
    }
    if (i < 0) rewards.push({ id: seq++, phone: c.referrer_phone, kind: 'breadsticks', earned_from_card: n, earned_on: r.redeemed_on, given_on: null, given_by: null, given_by_name: null });
    else if (!rewards[i].given_on) Object.assign(rewards[i], { phone: c.referrer_phone, earned_on: r.redeemed_on });
  }
  // referral_sync_pizza: one phone's medium pizzas
  function syncPizza(p) {
    if (!p) return;
    const counting = reds.filter((r) => { const c = cardOf(r.card_no); return c && !c.batch_id && c.referrer_phone === p && r.new_phone !== p; });
    const mine = rewards.filter((w) => w.phone === p && w.kind === 'medium_pizza');
    const taken = new Set(rewards.filter((w) => w.kind === 'medium_pizza' && w.given_on).map((w) => w.earned_from_card));
    const keep = pizzaPlan(counting, mine, taken).keep;
    const keepSet = new Set(keep.map((r) => r.card_no));
    for (let i = rewards.length - 1; i >= 0; i--) {
      const w = rewards[i];
      if (w.phone === p && w.kind === 'medium_pizza' && !w.given_on && !keepSet.has(w.earned_from_card)) rewards.splice(i, 1);
    }
    for (const r of keep) {
      const w = rewards.find((x) => x.earned_from_card === r.card_no && x.kind === 'medium_pizza');
      if (!w) rewards.push({ id: seq++, phone: p, kind: 'medium_pizza', earned_from_card: r.card_no, earned_on: r.redeemed_on, given_on: null, given_by: null, given_by_name: null });
      else if (!w.given_on) Object.assign(w, { phone: p, earned_on: r.redeemed_on });
    }
  }
  // the after-triggers
  function cardChanged(n, oldPhone) {
    syncReward(n);
    const c = cardOf(n);
    if (oldPhone && oldPhone !== c?.referrer_phone) syncPizza(oldPhone);
    if (c && !c.batch_id) syncPizza(c.referrer_phone);
  }
  function redemptionChanged(n) {
    syncReward(n);
    const c = cardOf(n);
    if (c && !c.batch_id && c.referrer_phone) syncPizza(c.referrer_phone);
  }

  const history = (p) => ({
    redeemed: reds.filter((r) => r.new_phone === p).sort((a, b) => (a.redeemed_on < b.redeemed_on ? -1 : 1))
      .map((r) => ({ ...r, card: cardOf(r.card_no) })),
    handedOut: cards.filter((c) => c.referrer_phone === p && !c.batch_id).sort((a, b) => (a.given_on < b.given_on ? -1 : 1))
      .map((c) => ({ ...c, redemption: reds.find((r) => r.card_no === c.card_no) || null })),
    rewards: rewards.filter((w) => w.phone === p).map((w) => ({ ...w })),
  });
  const own = (by, day) => isOwner() || (by === ctx.by && day === today);

  const store = {
    demo: true,
    async whoAmI() { return { id: me }; },
    async ping() {},
    async cardInfo(n) {
      return { card: withBatch(cardOf(n)), redemption: reds.find((r) => r.card_no === n) || null, cameFrom: chainOf(cards, reds)[n] ?? null };
    },
    async phoneHistory(p) { return history(p); },
    async saveHandout(row) {
      const p = normalizePhone(row.referrer_phone) || fail('Phone number must be 10 digits, like 253-555-0100');
      const nameErr = checkFullName(row.referrer_name); // 1.16.1: first and last name required (the page checks it too)
      if (nameErr) fail(nameErr);
      if (row.given_on > today) fail('The date given can\'t be in the future');
      const c = cardOf(row.card_no);
      const chk = handoutCheck({ card: withBatch(c) });
      if (chk.block) fail('A card can\'t be moved in or out of a hotel batch');
      const oldPhone = c?.referrer_phone || null;
      if (c) Object.assign(c, { given_on: row.given_on, referrer_name: cleanName(row.referrer_name), referrer_phone: p, ...(chk.fillIn ? stamp() : {}) });
      else cards.push({ card_no: row.card_no, given_on: row.given_on, referrer_name: cleanName(row.referrer_name), referrer_phone: p, batch_id: null, notes: '', ...stamp() });
      if (c) cardChanged(row.card_no, oldPhone); // the card trigger fires on update only
    },
    async saveBatch(row) {
      const taken = cards.filter((c) => c.card_no >= row.card_from && c.card_no <= row.card_to).map((c) => cardLabel(c.card_no));
      if (taken.length) fail(`These cards are already logged: ${taken.join(', ')}`);
      const phone = row.phone ? (normalizePhone(row.phone) || fail('Phone number must be 10 digits, like 253-555-0100')) : null;
      const b = { ...row, phone, id: seq++, ...stamp() };
      batches.push(b);
      for (let n = row.card_from; n <= row.card_to; n++) {
        cards.push({ card_no: n, given_on: row.given_on, referrer_name: row.label, referrer_phone: phone, batch_id: b.id, notes: '', ...stamp() });
      }
    },
    async savePersonalBatch(row) {
      const taken = cards.filter((c) => c.card_no >= row.card_from && c.card_no <= row.card_to).map((c) => cardLabel(c.card_no));
      if (taken.length) fail(`These cards are already logged: ${taken.join(', ')}`);
      for (const r of personalRows(row)) await store.saveHandout(r);
    },
    async signupList() { return signupList(cards, reds); },
    async markAdded(phones) {
      const now = `${today}T23:00:00Z`;
      for (const c of cards) if (!c.batch_id && phones.includes(c.referrer_phone) && !c.added_to_rewards_at) c.added_to_rewards_at = now;
      for (const r of reds) if (phones.includes(r.new_phone) && !r.added_to_rewards_at) r.added_to_rewards_at = now;
    },
    async saveRedemption(row) {
      const p = normalizePhone(row.new_phone) || fail('Phone number must be 10 digits, like 253-555-0100');
      const nameErr = checkFullName(row.new_name); // 1.16.1: first and last name required (the page checks it too)
      if (nameErr) fail(nameErr);
      const prev = reds.find((r) => r.card_no === row.card_no);
      if (prev) fail(`Card ${cardLabel(row.card_no)} was already redeemed on ${shortDay(prev.redeemed_on)} by ${formatPhone(prev.new_phone)}. Don't give the discount again.`);
      const info = await store.cardInfo(row.card_no);
      const chk = redeemCheck({ cardNo: row.card_no, info, phone: p, history: history(p), onDay: row.redeemed_on });
      if (chk.hard.length) fail(chk.hard[0].msg);
      if (chk.soft.length && !String(row.override_note || '').trim()) fail(`Needs a note to go ahead: ${chk.soft.map((s) => s.code).join(', ')}`);
      if (!info.card) cards.push({ card_no: row.card_no, given_on: null, referrer_name: '', referrer_phone: null, batch_id: null, notes: 'Redeemed before its hand-out was logged', ...stamp() });
      reds.push({ id: seq++, card_no: row.card_no, new_name: cleanName(row.new_name), new_phone: p, redeemed_on: row.redeemed_on, override_note: row.override_note || '', warnings: chk.soft.map((s) => s.code), ...stamp() });
      redemptionChanged(row.card_no);
    },
    async giveReward(id, day) {
      if (day > today) fail('The date given can\'t be in the future');
      const w = rewards.find((x) => x.id === id && !x.given_on);
      if (w) Object.assign(w, { given_on: day, given_by: ctx.by, given_by_name: PEOPLE[ctx.by] });
    },
    async owed() {
      return rewards.filter((w) => !w.given_on).map((w) => ({ ...w, name: cardOf(w.earned_from_card)?.referrer_name || '' }));
    },
    async hotelCounts() { return hotelCounts(batches, cards, reds, lunches); },
    async todayCount(day) { return reds.filter((r) => r.redeemed_on === day).length; },
    async hotelLunches() { return [...lunches].sort((a, b) => a.label.localeCompare(b.label) || a.lunch_no - b.lunch_no).map((l) => ({ ...l })); },
    // referral_lunch_before
    async deliverLunch(row) {
      const label = String(row.label || '').trim();
      const on = row.delivered_on || today;
      if (on > today) fail('The delivered date can\'t be in the future');
      if (!batches.some((b) => b.label === label)) fail(`No hotel batch is called "${label}"`);
      const h = hotelCounts(batches, cards, reds, lunches).find((x) => x.label === label);
      const done = lunches.filter((l) => l.label === label).length;
      const no = row.lunch_no || done + 1;
      if (no <= done) fail(`Lunch ${no} for ${label} is already recorded`);
      if (no !== done + 1) fail(`The next lunch for ${label} is lunch ${done + 1}`);
      if (no > Math.floor(h.redemptions / LUNCH_EVERY)) fail(`Lunch ${no} for ${label} isn't earned yet (${h.redemptions} cards turned in, one lunch per 25)`);
      const s = stamp();
      lunches.push({ id: seq++, label, lunch_no: no, delivered_on: on, delivered_by: s.created_by, delivered_by_name: s.by_name, notes: '', created_at: s.created_at, created_on: s.created_on });
    },
    // referral_undo
    async undo(what, id) {
      const target = Number(id);
      if (what === 'redemption') {
        const r = reds.find((x) => x.card_no === target);
        if (!r) return false;
        if (!own(r.created_by, r.created_on)) fail(UNDO_REFUSED);
        reds.splice(reds.indexOf(r), 1);
        redemptionChanged(r.card_no);
        const c = cardOf(r.card_no);
        if (c && !c.given_on && !c.batch_id) cards.splice(cards.indexOf(c), 1);
        return true;
      }
      if (what === 'handout') {
        const c = cardOf(target);
        if (!c || c.batch_id || !c.given_on) return false;
        if (!own(c.created_by, c.created_on)) fail(UNDO_REFUSED);
        const oldPhone = c.referrer_phone;
        if (reds.some((r) => r.card_no === target)) {
          Object.assign(c, { given_on: null, referrer_name: '', referrer_phone: null, notes: 'Redeemed before its hand-out was logged' });
          cardChanged(target, oldPhone);
        } else {
          cards.splice(cards.indexOf(c), 1);
          for (let i = rewards.length - 1; i >= 0; i--) if (rewards[i].earned_from_card === target) rewards.splice(i, 1); // on delete cascade
        }
        return true;
      }
      if (what === 'batch') {
        const b = batches.find((x) => x.id === target);
        if (!b) return false;
        if (!own(b.created_by, b.created_on)) fail(UNDO_REFUSED);
        if (cards.some((c) => c.batch_id === b.id && reds.some((r) => r.card_no === c.card_no))) {
          fail('Cards from this batch were already turned in, so it can\'t be undone. Ask the owner.');
        }
        batches.splice(batches.indexOf(b), 1);
        for (let i = cards.length - 1; i >= 0; i--) if (cards[i].batch_id === b.id) cards.splice(i, 1);
        return true;
      }
      if (what === 'lunch') {
        const l = lunches.find((x) => x.id === target);
        if (!l) return false;
        if (!own(l.delivered_by, l.created_on)) fail(UNDO_REFUSED);
        lunches.splice(lunches.indexOf(l), 1);
        return true;
      }
      if (what === 'reward') {
        const w = rewards.find((x) => x.id === target);
        if (!w || !w.given_on) return false;
        if (!isOwner() && !(w.given_by === ctx.by && w.given_on === today)) fail(UNDO_REFUSED);
        Object.assign(w, { given_on: null, given_by: null, given_by_name: null });
        if (w.kind === 'medium_pizza') syncPizza(w.phone); else syncReward(w.earned_from_card);
        return true;
      }
      return fail(`Nothing to undo called "${what}"`);
    },
    async todayEntries(day) {
      const at = (x) => ({ at: x.created_at, day: x.created_on });
      return [
        ...reds.map((r) => ({ what: 'redemption', id: r.card_no, ...at(r), by: r.created_by, by_name: r.by_name, row: { ...r } })),
        ...cards.filter((c) => !c.batch_id && c.given_on).map((c) => ({ what: 'handout', id: c.card_no, ...at(c), by: c.created_by, by_name: c.by_name, row: { ...c } })),
        ...batches.map((b) => ({ what: 'batch', id: b.id, ...at(b), by: b.created_by, by_name: b.by_name, row: { ...b } })),
        ...lunches.map((l) => ({ what: 'lunch', id: l.id, ...at(l), by: l.delivered_by, by_name: l.delivered_by_name, row: { ...l } })),
        ...rewards.filter((w) => w.given_on).map((w) => ({ what: 'reward', id: w.id, at: '', day: w.given_on, by: w.given_by, by_name: w.given_by_name, row: { ...w } })),
      ].filter((x) => x.day === day).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    },
    async recent() { return []; },
  };

  // ---------- the made-up story (dates count back from today) ----------
  const as = async (by, day, fn) => { const keep = { ...ctx }; Object.assign(ctx, { by, day }); try { await fn(); } finally { Object.assign(ctx, keep); } };
  const ago = (n) => addDays(today, -n);
  const guest = (n) => `253555${String(2000 + n).padStart(4, '0')}`; // hotel guests and other new customers: 253-555-2xxx
  // made-up first and last names for them (1.16.1: every new customer gives both)
  const FIRST = ['Alex', 'Jamie', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Drew', 'Avery', 'Quinn', 'Rowan', 'Elena', 'Marcus', 'Hana'];
  const LAST = ['Nguyen', 'Garcia', 'Smith', 'Kim', 'Patel', 'Brown', 'Okafor', 'Rossi', 'Novak', 'Haddad', 'Larsen'];
  const guestName = (n) => `${FIRST[n % FIRST.length]} ${LAST[Math.floor(n / FIRST.length) % LAST.length]}`;
  const seed = async () => {
    const M = 'demo-maria';
    // hotels: TownePlace Suites 0101-0150 (17 turned in, no lunch yet); WoodSpring Suites 0201-0280 (52 turned in,
    // 2 lunches earned, 1 delivered, 1 owed)
    await as(M, ago(40), () => store.saveBatch({ label: 'WoodSpring Suites', phone: '2535550198', card_from: 201, card_to: 280, given_on: ago(40), notes: 'front desk' }));
    await as(M, ago(20), () => store.saveBatch({ label: 'TownePlace Suites', phone: '2535550199', card_from: 101, card_to: 150, given_on: ago(20), notes: 'front desk' }));
    for (let i = 0; i < 52; i++) { const d = ago(38 - Math.floor(i * 37 / 52)); await as(M, d, () => store.saveRedemption({ card_no: 201 + i, new_name: guestName(i), new_phone: guest(100 + i), redeemed_on: d })); }
    for (let i = 0; i < 16; i++) { const d = ago(18 - i); await as(M, d, () => store.saveRedemption({ card_no: 101 + i, new_name: guestName(60 + i), new_phone: guest(200 + i), redeemed_on: d })); }
    await as(M, ago(6), () => store.deliverLunch({ label: 'WoodSpring Suites', lunch_no: 1, delivered_on: ago(6) }));
    // Maya Lopez: cards 0011-0017, 5 turned in -> 1 medium pizza owed, breadsticks for 0011 given, 4 owed
    await as(M, ago(30), () => store.savePersonalBatch({ name: 'Maya Lopez', phone: '2535550141', card_from: 11, card_to: 17, given_on: ago(30) }));
    const maya = [['Jordan Reyes', 25], ['Priya Shah', 21], ['Chris Park', 16], ['Sam Ortiz', 10], ['Theo Grant', 2]];
    for (let i = 0; i < maya.length; i++) { const d = ago(maya[i][1]); await as(M, d, () => store.saveRedemption({ card_no: 11 + i, new_name: maya[i][0], new_phone: guest(300 + i), redeemed_on: d })); }
    await as(M, ago(12), async () => store.giveReward(rewards.find((w) => w.earned_from_card === 11 && w.kind === 'breadsticks').id, ago(12)));
    // Rosa Diaz: cards 0031-0040, 8 turned in -> 2 pizzas, the first given; 7 breadsticks given (one today by Demo), 1 owed
    await as(M, ago(45), () => store.savePersonalBatch({ name: 'Rosa Diaz', phone: '2535550163', card_from: 31, card_to: 40, given_on: ago(45) }));
    for (let i = 0; i < 8; i++) { const d = ago(40 - i * 4); await as(M, d, () => store.saveRedemption({ card_no: 31 + i, new_name: guestName(90 + i), new_phone: guest(400 + i), redeemed_on: d })); }
    await as(M, ago(9), async () => store.giveReward(rewards.find((w) => w.phone === '2535550163' && w.kind === 'medium_pizza' && w.earned_from_card === 34).id, ago(9)));
    for (let n = 31; n <= 36; n++) await as(M, ago(30 - n + 31), async () => store.giveReward(rewards.find((w) => w.earned_from_card === n && w.kind === 'breadsticks').id, ago(30 - n + 31)));
    await as(me, today, async () => store.giveReward(rewards.find((w) => w.earned_from_card === 37 && w.kind === 'breadsticks').id, today));
    // Omar Haddad: cards 0041-0045, 3 turned in -> breadsticks owed (3); his next card turned in earns a pizza
    await as(M, ago(14), () => store.savePersonalBatch({ name: 'Omar Haddad', phone: '2535550127', card_from: 41, card_to: 45, given_on: ago(14) }));
    for (let i = 0; i < 3; i++) { const d = ago(12 - i * 3); await as(M, d, () => store.saveRedemption({ card_no: 41 + i, new_name: guestName(110 + i), new_phone: guest(500 + i), redeemed_on: d })); }
    // Ken Ito: card 0021, turned in today by Lee Chen (entered by Maria) -> breadsticks owed
    await as(M, ago(8), () => store.saveHandout({ card_no: 21, given_on: ago(8), referrer_name: 'Ken Ito', referrer_phone: '2535550152' }));
    await as(M, today, () => store.saveRedemption({ card_no: 21, new_name: 'Lee Chen', new_phone: '2535550174', redeemed_on: today }));
    // Dave Moss: card 0004, handed out 70 days ago (expired); hotel guest and a hand-out today by Demo
    await as(M, ago(70), () => store.saveHandout({ card_no: 4, given_on: ago(70), referrer_name: 'Dave Moss', referrer_phone: '2535550104' }));
    await as(me, today, () => store.saveRedemption({ card_no: 117, new_name: 'Nina Brooks', new_phone: '2535550190', redeemed_on: today }));
    await as(me, today, () => store.saveHandout({ card_no: 50, given_on: today, referrer_name: 'Ana Silva', referrer_phone: '2535550185' }));
    // Owner.com: everyone added already except today's new people and Maya's latest friend
    const left = new Set(['2535550185', '2535550174', '2535550190', guest(304)]);
    await store.markAdded(signupList(cards, reds).map((x) => x.phone).filter((p) => !left.has(p)));
  };
  store.ready = seed();
  return store;
}
