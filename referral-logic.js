// Referral cards (version 1.14.0; reward tiers and undo 1.16.0; required names and field checks 1.16.1): the program's rules, worked out on the page
// before anything is saved. The database (phone/supabase_referral.sql, supabase_referral_tiers.sql) checks the
// same rules again, so the page can't skip them, and the demo (referral-demo.js) follows them exactly.
// No imports: dates are 'YYYY-MM-DD' strings in the store's time zone, worked out by the caller.

export const EXPIRY_DAYS = 60; // a card is good for 60 days from the day it was given
export const LUNCH_EVERY = 25; // every 25 redemptions from one hotel = lunch for its front desk
export const PIZZA_EVERY = 4; // every 4 of a person's cards redeemed = one free medium pizza (2026-11-03)
export const MAX_CARD = 1000;

// What anyone types -> '2535550100', or '' when it isn't a 10-digit US number (a leading 1 is dropped).
export function normalizePhone(text) {
  let d = String(text ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return /^[2-9]\d{9}$/.test(d) ? d : '';
}
// '2535550100' -> '(253) 555-0100'
export const formatPhone = (d) => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || '');
// While typing: '25355' -> '(253) 55'
export function typingPhone(text) {
  let d = String(text ?? '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  d = d.slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// '42', '0042', '#0042' -> 42; anything outside 1-1000 -> null
export function parseCard(text) {
  const s = String(text ?? '').trim().replace(/^#/, '');
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MAX_CARD ? n : null;
}
export const cardLabel = (n) => String(n).padStart(4, '0');

export function addDays(k, n) {
  const [y, m, d] = k.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  const [ya, ma, da] = a.split('-').map(Number);
  const [yb, mb, db] = b.split('-').map(Number);
  return Math.round((Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da)) / 86400000);
}
export const isDay = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '') && addDays(k, 0) === k;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = (k) => (k ? `${MONTHS[Number(k.slice(5, 7)) - 1]} ${Number(k.slice(8, 10))}` : '');

// What we know about one card. info = { card: row | null, redemption: row | null } where card has
// { card_no, given_on, referrer_name, referrer_phone, batch_id, batch: { label } | null }.
// onDay = the day it's being redeemed (or today).
export function cardStatus(info, onDay) {
  const card = info?.card || null;
  const redemption = info?.redemption || null;
  let kind = 'none'; // never logged
  if (card?.batch_id) kind = 'hotel';
  else if (card?.given_on) kind = 'person';
  else if (card) kind = 'placeholder'; // redeemed before its hand-out was logged
  const expiresOn = card?.given_on ? addDays(card.given_on, EXPIRY_DAYS) : null;
  return {
    kind,
    logged: kind === 'hotel' || kind === 'person',
    redeemed: !!redemption,
    expiresOn,
    expired: !!(expiresOn && onDay > expiresOn),
    daysLeft: expiresOn ? daysBetween(onDay, expiresOn) : null,
    hotel: kind === 'hotel' ? (card.batch?.label || card.referrer_name || 'hotel') : '',
  };
}

// The checks before saving a redeemed card. history = what the database has for the new customer's
// phone: { redeemed: [{ card_no, redeemed_on }], handedOut: [{ card_no, given_on, batch_id }] }; cardNo = the card.
// hard = can't be saved; soft = needs a note to go ahead (the same codes the database records).
export function redeemCheck({ cardNo, info, phone, history, onDay }) {
  const st = cardStatus(info, onDay);
  const hard = [];
  const soft = [];
  const card = info?.card;
  if (st.redeemed) hard.push({ code: 'already_redeemed', msg: turnedInMsg(cardNo, info.redemption) });
  if (phone && card?.referrer_phone && card.referrer_phone === phone) {
    hard.push({ code: 'own_card', msg: 'That\'s the phone number this card was handed to. A card is for a new customer, not the person who gave it out.' });
  }
  if (!st.logged) {
    soft.push({ code: 'not_logged', msg: `Card ${cardLabel(cardNo)} isn't in the hand-out log yet. If it's on the paper log, enter the hand-out first.` });
  } else if (st.expired) {
    soft.push({ code: 'expired', msg: `Expired: given ${shortDay(card.given_on)}, good until ${shortDay(st.expiresOn)}.` });
  } else if (card?.given_on && onDay && onDay < card.given_on) {
    // 1.23.0: the owner picks the day it was turned in; a day before the hand-out is most likely a wrong date
    soft.push({ code: 'before_handout', msg: `Turned in before it was handed out: card ${cardLabel(cardNo)} was given ${shortDay(card.given_on)}. Check the date.` });
  }
  if (phone && history) {
    const before = (history.redeemed || []).filter((r) => r.card_no !== cardNo);
    if (before.length) {
      soft.push({ code: 'repeat_customer', msg: `This phone already used card ${before.map((r) => cardLabel(r.card_no)).join(', ')} (${shortDay(before[0].redeemed_on)}). New customers only.` });
    }
    const given = (history.handedOut || []).filter((c) => !c.batch_id && c.given_on && c.given_on < onDay);
    if (given.length) {
      soft.push({ code: 'existing_customer', msg: `This phone was handed card ${given.map((c) => cardLabel(c.card_no)).join(', ')} on ${shortDay(given[0].given_on)}, so they're already a customer.` });
    }
  }
  return { status: st, hard, soft };
}

// Before saving a hand-out row: may it be saved, and does it replace something?
export function handoutCheck(info) {
  const card = info?.card;
  if (!card) return { block: '', replace: '', fillIn: false };
  if (card.batch_id) {
    return { block: `Card ${cardLabel(card.card_no)} is in the ${card.batch?.label || card.referrer_name || 'hotel'} batch. Hotel cards can't be handed to a person.`, replace: '', fillIn: false };
  }
  if (!card.given_on) {
    return { block: '', replace: '', fillIn: true }; // redeemed before its hand-out was logged: fills it in
  }
  return {
    block: '',
    replace: `Card ${cardLabel(card.card_no)} is already logged: ${card.referrer_name || 'no name'}, ${formatPhone(card.referrer_phone)}, ${shortDay(card.given_on)}. Saving replaces it.`,
    fillIn: false,
  };
}

// Where each card came from (the same rule as the referral_chain view): the card its referrer
// redeemed on or before the day this card was given. Used by the no-sign-in demo.
export function chainOf(cards, redemptions) {
  const out = {};
  const byPhone = {};
  for (const r of [...redemptions].sort((a, b) => (a.redeemed_on < b.redeemed_on ? -1 : a.redeemed_on > b.redeemed_on ? 1 : a.id - b.id))) {
    (byPhone[r.new_phone] ||= []).push(r);
  }
  for (const c of cards) {
    const from = (byPhone[c.referrer_phone] || []).find((r) => c.given_on && r.redeemed_on <= c.given_on);
    out[c.card_no] = from ? from.card_no : null;
  }
  return out;
}

// Hotel counts (the same rule as the referral_hotel_counts view; lunches delivered and owed since 1.16.0).
export function hotelCounts(batches, cards, redemptions, lunches = []) {
  const redeemed = new Set(redemptions.map((r) => r.card_no));
  const byLabel = {};
  for (const b of batches) {
    const h = (byLabel[b.label] ||= { label: b.label, cards_given: 0, redemptions: 0 });
    for (const c of cards) {
      if (c.batch_id !== b.id) continue;
      h.cards_given += 1;
      if (redeemed.has(c.card_no)) h.redemptions += 1;
    }
  }
  return Object.values(byLabel).map((h) => {
    const earned = Math.floor(h.redemptions / LUNCH_EVERY);
    const delivered = lunches.filter((l) => l.label === h.label).length;
    return {
      ...h,
      lunches_earned: earned,
      to_next_lunch: LUNCH_EVERY - (h.redemptions % LUNCH_EVERY),
      lunches_delivered: delivered,
      lunches_owed: Math.max(earned - delivered, 0),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

// Phones to add to Owner.com rewards (the same rule as the referral_rewards_signup view): everyone handed a card
// (not hotel front desks) and every new customer, one row per phone, until any of its rows is ticked off.
export function signupList(cards, redemptions) {
  const seen = [
    ...cards.filter((c) => !c.batch_id && c.referrer_phone)
      .map((c) => ({ phone: c.referrer_phone, name: c.referrer_name || '', source: 'referrer', at: c.created_at, added: c.added_to_rewards_at })),
    ...redemptions.map((r) => ({ phone: r.new_phone, name: r.new_name || '', source: 'new customer', at: r.created_at, added: r.added_to_rewards_at })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const by = new Map();
  for (const x of seen) {
    const p = by.get(x.phone) || { phone: x.phone, name: '', sources: new Set(), first_seen: x.at, added: false };
    if (!p.name && x.name) p.name = x.name;
    p.sources.add(x.source);
    p.added ||= !!x.added;
    by.set(x.phone, p);
  }
  return [...by.values()].filter((p) => !p.added)
    .map(({ phone, name, sources, first_seen }) => ({ phone, name, sources: [...sources].sort().join(' + '), first_seen }));
}

// The cards of a personal batch: one ordinary hand-out row per card, all to the same person.
export function personalRows({ name, phone, card_from, card_to, given_on }) {
  const rows = [];
  for (let n = card_from; n <= card_to; n++) rows.push({ card_no: n, given_on, referrer_name: name, referrer_phone: phone });
  return rows;
}

// ---------- version 1.16.0: the counter tablet ----------

// The answer when a card was already turned in (the page's check, and a save the database refused because
// someone else turned it in meanwhile).
export function turnedInMsg(cardNo, redemption) {
  const by = redemption?.new_phone ? ` by ${redemption.new_name ? `${redemption.new_name}, ` : ''}${formatPhone(redemption.new_phone)}` : '';
  return `Card ${cardLabel(cardNo)} was already turned in${redemption?.redeemed_on ? ` on ${shortDay(redemption.redeemed_on)}` : ''}${by}. Don't give the discount again.`;
}

// Does this redeemed card count toward its referrer's medium pizza? Personal cards only (not hotel batches),
// with a known referrer, not turned in by the referrer's own phone.
export const countsTowardPizza = (card, redemption) => !!(card && redemption && !card.batch_id && card.referrer_phone
  && redemption.new_phone !== card.referrer_phone);

// One phone's medium pizzas, the same rule as referral_sync_pizza() in supabase_referral_tiers.sql.
// redeemed = [{ card_no, redeemed_on }] of the phone's counting cards; pizzas = its medium_pizza reward rows.
// Returns which cards should carry an ungiven pizza: earned (every 4th, in order of redeemed date then card
// number) minus the pizzas already given; what's still owed sits on the latest earning cards.
// takenCards (optional) = every card that already carries a given pizza, whoever's (the database checks all).
export function pizzaPlan(redeemed, pizzas, takenCards = null) {
  const order = [...redeemed].sort((a, b) => (a.redeemed_on < b.redeemed_on ? -1 : a.redeemed_on > b.redeemed_on ? 1 : a.card_no - b.card_no));
  const given = pizzas.filter((w) => w.given_on);
  const givenCards = takenCards || new Set(given.map((w) => w.earned_from_card));
  const earned = Math.floor(order.length / PIZZA_EVERY);
  const need = Math.max(earned - given.length, 0);
  const candidates = order.filter((r, i) => (i + 1) % PIZZA_EVERY === 0 && !givenCards.has(r.card_no));
  const keep = need ? candidates.slice(-need) : [];
  return { count: order.length, earned, given: given.length, keep };
}

// Progress toward the next pizza: "4 referrals redeemed, next medium pizza at 8".
export function pizzaProgress(count) {
  const next = (Math.floor(count / PIZZA_EVERY) + 1) * PIZZA_EVERY;
  return { count, earned: Math.floor(count / PIZZA_EVERY), next, toNext: next - count,
    text: `${count} referral${count === 1 ? '' : 's'} redeemed, next medium pizza at ${next}` };
}

// Did this redemption (the count-th counting card) complete a group of 4?
export const completesPizza = (count) => count > 0 && count % PIZZA_EVERY === 0;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The big banner at the counter, from a phone's reward rows (breadsticks and pizzas, owed = not given).
export function owedSummary(rewards) {
  const owed = (rewards || []).filter((w) => !w.given_on);
  const pizzas = owed.filter((w) => w.kind === 'medium_pizza').length;
  const sticks = owed.filter((w) => (w.kind || 'breadsticks') === 'breadsticks').length;
  const parts = [];
  if (pizzas) parts.push(`${plural(pizzas, 'free medium pizza', 'free medium pizzas')}`);
  if (sticks) parts.push(sticks === 1 ? 'breadsticks' : `breadsticks (${sticks})`);
  return { pizzas, sticks, any: !!parts.length, text: parts.length ? `Owed now: ${parts.join(' and ')}` : 'Nothing owed right now' };
}

// Everything the counter shows for one phone, from phoneHistory(p): the name on file (latest hand-out, else
// the name they gave when they turned a card in), the card they came with, the cards they handed out and
// how many of those count toward a pizza, and their rewards (owed first, oldest first).
export function phoneSummary(p, h) {
  const cards = [...(h.handedOut || [])].sort((a, b) => ((a.given_on || '') < (b.given_on || '') ? 1 : -1));
  const name = cards.find((c) => c.referrer_name)?.referrer_name || (h.redeemed || []).find((r) => r.new_name)?.new_name || '';
  const counting = (h.handedOut || []).filter((c) => countsTowardPizza({ ...c, referrer_phone: p }, c.redemption));
  const rewards = [...(h.rewards || [])].sort((a, b) => (a.earned_on < b.earned_on ? -1 : a.earned_on > b.earned_on ? 1 : a.id - b.id));
  return {
    phone: p,
    name,
    known: !!((h.handedOut || []).length || (h.redeemed || []).length || rewards.length),
    cameWith: (h.redeemed || [])[0] || null,
    handedOut: h.handedOut || [],
    owed: owedSummary(rewards),
    owedRows: [...rewards.filter((w) => !w.given_on && w.kind === 'medium_pizza'), ...rewards.filter((w) => !w.given_on && w.kind !== 'medium_pizza')],
    givenRows: rewards.filter((w) => w.given_on).sort((a, b) => (a.given_on < b.given_on ? 1 : a.given_on > b.given_on ? -1 : b.id - a.id)),
    progress: pizzaProgress(counting.length),
  };
}

export const rewardName = (w) => (w.kind === 'medium_pizza' ? 'Free medium pizza' : 'Free breadsticks');

// A hotel's lunches: owed = earned - delivered (never below 0), and the number the next delivery gets.
export function lunchState(h, lunches = []) {
  const mine = lunches.filter((l) => l.label === h.label).sort((a, b) => a.lunch_no - b.lunch_no);
  const delivered = mine.length;
  const earned = Math.floor(h.redemptions / LUNCH_EVERY);
  return {
    earned,
    delivered,
    owed: Math.max(earned - delivered, 0),
    nextNo: delivered + 1,
    toNext: LUNCH_EVERY - (h.redemptions % LUNCH_EVERY),
    sinceLast: h.redemptions % LUNCH_EVERY,
    history: mine,
  };
}

// The line after a hotel card is turned in: "TownePlace Suites: 18 / 25 to next lunch", or "Lunch earned".
export function hotelLine(h) {
  if (!h) return '';
  const n = h.redemptions % LUNCH_EVERY;
  return n === 0 && h.redemptions > 0 ? `Lunch earned for ${h.label}` : `${h.label}: ${n} / ${LUNCH_EVERY} to next lunch`;
}

// Undo (the same rule as referral_undo() in supabase_referral_tiers.sql): the owner may undo anything; an
// employee only their own entry, on the day it was entered (store time). entry = { by, day } where by = the
// login that entered it (created_by / delivered_by / given_by) and day = the store day it was entered
// (a reward: the day it was marked given).
export function canUndo(entry, me, owner, today) {
  if (!entry) return false;
  if (owner) return true;
  return !!(me && entry.by === me && entry.day === today);
}
export const UNDO_REFUSED = 'Only your own entries from today can be undone. Ask the owner.';

// ---------- version 1.16.1: names required, plain checks next to each field, two-tap confirm, fix a mistake ----------

// Names: first AND last, each at least 2 letters; letters, spaces, hyphens and apostrophes only. Saved as one
// string "First Last" in new_name / referrer_name (the database stays permissive; the page and the demo enforce it).
export const cleanName = (s) => String(s ?? '').replace(/’/g, '\'').replace(/\s+/g, ' ').trim();
export function checkName(text, which = 'First name') {
  const s = cleanName(text);
  if (!s) return `${which} is missing`;
  if (!/^[\p{L}' -]+$/u.test(s)) return `${which}: letters only`;
  if ((s.match(/\p{L}/gu) || []).length < 2) return `${which} needs at least 2 letters`;
  return '';
}
export const fullName = (first, last) => `${cleanName(first)} ${cleanName(last)}`.trim();
// "Maya Lopez" -> { first: 'Maya', last: 'Lopez' }; "Mary Ann de Vries" -> first word, then the rest
export function splitName(full) {
  const s = cleanName(full);
  const i = s.indexOf(' ');
  return i < 0 ? { first: s, last: '' } : { first: s.slice(0, i), last: s.slice(i + 1) };
}
// '' when a saved name has both parts, else the first thing that's wrong (the demo store's check)
export function checkFullName(full) {
  const { first, last } = splitName(full);
  return checkName(first, 'First name') || checkName(last, 'Last name');
}
// digits only, at most max of them
export const digitsOnly = (text, max = 99) => String(text ?? '').replace(/\D/g, '').slice(0, max);

function phoneMsg(text) {
  const d = String(text ?? '').replace(/\D/g, '');
  if (!d) return 'Phone number is missing';
  if (normalizePhone(d)) return '';
  if (d.length < 10) return 'Phone number needs 10 digits';
  return 'Check the phone number: it isn\'t a US number';
}
function cardMsg(text) {
  const s = String(text ?? '').trim();
  if (!s) return 'Card number is missing';
  return parseCard(s) ? '' : `Card numbers go from 0001 to ${cardLabel(MAX_CARD)}`;
}

// The checks next to each box on "Card turned in", as the person types. info = cardInfo() for the card in the
// box, or null while it's still being looked up. Each field: { msg, block }; a block keeps Save off. A card that
// isn't in the hand-out log is said plainly but doesn't block (it can go ahead with a note).
// 1.23.0: with today, the "Date turned in" box (day) is checked too, and onDay is that day when it's allowed.
export function validateTurnIn({ card, phone, first, last, info = null, onDay = '', day = '', today = '' }) {
  const n = parseCard(card);
  const out = { n, p: normalizePhone(phone), name: fullName(first, last), fields: {} };
  if (today) {
    const dm = checkTurnInDay(day, today);
    out.fields.day = { msg: dm, block: !!dm };
    out.day = dm ? '' : day;
    onDay = dm ? today : day;
  }
  let cm = cardMsg(card);
  let block = !!cm;
  if (!cm && info) {
    const st = cardStatus(info, onDay);
    if (st.redeemed) { cm = `Card ${cardLabel(n)} was already turned in${info.redemption?.redeemed_on ? ` on ${shortDay(info.redemption.redeemed_on)}` : ''}`; block = true; }
    else if (!st.logged) cm = `Card ${cardLabel(n)} was not logged as handed out`;
  }
  out.fields.card = { msg: cm, block };
  const pm = phoneMsg(phone);
  out.fields.phone = { msg: pm, block: !!pm };
  const fm = checkName(first, 'First name');
  out.fields.first = { msg: fm, block: !!fm };
  const lm = checkName(last, 'Last name');
  out.fields.last = { msg: lm, block: !!lm };
  out.checking = !!(n && !info);
  out.ok = !out.checking && Object.values(out.fields).every((f) => !f.block);
  return out;
}
// The same for "Log a hand-out" (the referrer); whether the card may be saved over is handoutCheck().
export function validateHandout({ card, phone, first, last }) {
  const fields = {};
  for (const [k, msg] of [['card', cardMsg(card)], ['phone', phoneMsg(phone)], ['first', checkName(first, 'First name')], ['last', checkName(last, 'Last name')]]) {
    fields[k] = { msg, block: !!msg };
  }
  return { n: parseCard(card), p: normalizePhone(phone), name: fullName(first, last), fields, ok: Object.values(fields).every((f) => !f.block) };
}

// Two-tap buttons (Given, Delivered): the first tap arms the button ("Tap again to confirm"); a second tap
// within CONFIRM_MS writes; after that it's back to normal by itself.
export const CONFIRM_MS = 6000;
export const tapState = (armedAt, now, ms = CONFIRM_MS) => (armedAt && now >= armedAt && now - armedAt < ms ? 'armed' : 'idle');

// Fix a mistake: what goes back into the form after an entry is undone.
export function turnInPrefill(r) {
  const { first, last } = splitName(r?.new_name);
  return { card: cardLabel(r.card_no), phone: formatPhone(r.new_phone), first, last, note: r.override_note || '', day: r.redeemed_on || '' };
}

// ---------- version 1.23.0: staff put cards in the box, the owner enters them later with the date ----------
export const BACKDATE_DAYS = 14; // the owner enters the box within a day or so; two weeks is the most
export const turnInDayRange = (today) => ({ min: addDays(today, -BACKDATE_DAYS), max: today });
export const TURNIN_DAY_MSG = `Pick a date in the last ${BACKDATE_DAYS} days.`;
// '' when day may be used as the day a card was turned in (today back to 14 days ago), else the message
export function checkTurnInDay(day, today) {
  if (!isDay(day) || !isDay(today)) return TURNIN_DAY_MSG;
  const { min, max } = turnInDayRange(today);
  return day < min || day > max ? TURNIN_DAY_MSG : '';
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// "Wed, Nov 12"
export function longDay(k) {
  if (!isDay(k)) return '';
  const [y, m, d] = k.split('-').map(Number);
  return `${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${shortDay(k)}`;
}
// Only the owner enters turned-in cards (2026-11-12): staff give the 10% in Clover and put the card in the box.
// The screens of that form; any way an employee would land on one goes Home instead.
export const OWNER_SCREENS = ['turnin', 'review', 'done'];
export const screenFor = (scr, owner) => (!owner && OWNER_SCREENS.includes(scr) ? 'home' : scr);
// What the Saved screen says. day = the day it was turned in. Today: ring up the 10% now. An earlier day (from
// the box): the discount was given then, so only "Saved." and the date.
export function savedText({ n, name, phone, day, today }) {
  const who = [name, formatPhone(phone)].filter(Boolean).join(', ');
  // Only the owner enters cards (from the box), and the employee gave the 10% at the counter, so the
  // Saved screen never repeats the 10% or the Clover step; it names the day when it is not today.
  if (!day || day === today) return { big: 'Saved.', sub: `Card ${cardLabel(n)}, ${who} · turned in today` };
  return { big: 'Saved.', sub: `Card ${cardLabel(n)}, ${who} · turned in ${shortDay(day)}` };
}
export function handoutPrefill(c) {
  const { first, last } = splitName(c?.referrer_name);
  return { card: cardLabel(c.card_no), date: c.given_on || '', phone: formatPhone(c.referrer_phone), first, last };
}

// ---------- version 1.20.0: people lookup as you type ----------

// One entry per phone (digits only) from the rows the page already may read: personal hand-outs (referrers),
// redeemed cards (new customers) and hotel batches (front-desk phones). cards = [{ card_no, referrer_name,
// referrer_phone, given_on, batch_id }] (hotel cards are skipped: their batch row says it), redemptions =
// [{ card_no, new_name, new_phone, redeemed_on }], batches = [{ label, phone, given_on }].
// Entry: { phone, name (the latest non-empty one), names (every one seen, for matching), referrer, newCustomer,
// hotels: [labels], cards (handed to them), turnedIn (of those, turned in by someone else), used (cards they
// turned in themselves), last (latest day seen) }.
export function buildPeopleIndex({ cards = [], redemptions = [], batches = [] } = {}) {
  const by = new Map();
  const redByCard = new Map(redemptions.map((r) => [r.card_no, r]));
  const touch = (rawPhone, name, day, fn) => {
    const phone = normalizePhone(rawPhone);
    if (!phone) return;
    let e = by.get(phone);
    if (!e) {
      e = { phone, name: '', nameDay: '', names: [], referrer: false, newCustomer: false, hotels: [], cards: 0, turnedIn: 0, used: 0, last: '' };
      by.set(phone, e);
    }
    const n = cleanName(name);
    const d = day || '';
    if (n) {
      if (!e.names.includes(n)) e.names.push(n);
      if (!e.name || d >= e.nameDay) { e.name = n; e.nameDay = d; }
    }
    if (d > e.last) e.last = d;
    fn(e);
  };
  for (const c of cards) {
    if (c.batch_id) continue;
    touch(c.referrer_phone, c.referrer_name, c.given_on, (e) => {
      e.referrer = true;
      e.cards += 1;
      const r = redByCard.get(c.card_no);
      if (r && normalizePhone(r.new_phone) !== e.phone) e.turnedIn += 1;
    });
  }
  for (const r of redemptions) {
    touch(r.new_phone, r.new_name, r.redeemed_on, (e) => { e.newCustomer = true; e.used += 1; });
  }
  for (const b of batches) {
    touch(b.phone, b.label, b.given_on, (e) => { if (b.label && !e.hotels.includes(b.label)) e.hotels.push(b.label); });
  }
  return [...by.values()].map(({ nameDay, ...e }) => e)
    .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : a.phone.localeCompare(b.phone)));
}

// The small plain label under a suggestion: "Referrer · 7 cards, 3 turned in", "New customer", a hotel's name.
export function personLabel(e) {
  const parts = [];
  if (e.referrer) parts.push(`Referrer · ${plural(e.cards, 'card', 'cards')}${e.turnedIn ? `, ${e.turnedIn} turned in` : ''}`);
  if (e.newCustomer) parts.push('New customer');
  for (const h of e.hotels || []) parts.push(`${h} front desk`);
  return parts.join(' · ');
}

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s) => fold(s).split(/[\s-]+/).filter(Boolean);

// What was typed in a phone box, for the lookup: { kind: 'digits' | 'name' | '', q }. Letters mean a name;
// otherwise the digits (a leading 1 on 11 digits is dropped). Under 2 characters: kind ''.
export function lookupQuery(text) {
  const s = String(text ?? '');
  if (/\p{L}/u.test(s)) {
    const toks = words(s.replace(/[^\p{L}\p{M}'\s-]/gu, ' '));
    return toks.join('').length >= 2 ? { kind: 'name', q: toks } : { kind: '', q: '' };
  }
  let d = s.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length >= 2 ? { kind: 'digits', q: d } : { kind: '', q: '' };
}

// Phone '2535550141' with digits [start, start+len) marked -> [{ text, hit }] over '(253) 555-0141'.
export function highlightPhone(phone, start = -1, len = 0) {
  const f = formatPhone(phone);
  const out = [];
  let i = 0;
  for (const ch of f) {
    const hit = /\d/.test(ch) ? (i >= start && i < start + len) : false;
    if (/\d/.test(ch)) i += 1;
    // a bracket or dash inside a marked run stays marked, so the highlight reads as one piece
    const inside = !/\d/.test(ch) && i > start && i < start + len;
    const h = hit || inside;
    if (out.length && out[out.length - 1].hit === h) out[out.length - 1].text += ch;
    else out.push({ text: ch, hit: h });
  }
  return out;
}

// A name with the start of each matched word marked -> [{ text, hit }].
export function highlightName(name, toks = []) {
  const out = [];
  const push = (text, hit) => {
    if (!text) return;
    if (out.length && out[out.length - 1].hit === hit) out[out.length - 1].text += text;
    else out.push({ text, hit });
  };
  for (const part of String(name ?? '').split(/([\s-]+)/)) {
    if (!part || /^[\s-]+$/.test(part)) { push(part, false); continue; }
    const w = fold(part);
    const t = toks.filter((x) => w.startsWith(x)).sort((a, b) => b.length - a.length)[0];
    // the folded word has the same length as the shown one for ordinary names; if not, mark the whole word
    const n = t ? (fold(part.slice(0, t.length)) === t ? t.length : part.length) : 0;
    push(part.slice(0, n), true);
    push(part.slice(n), false);
  }
  return out;
}

// The people whose phone or name matches what was typed, best first, at most max.
// Digits: anywhere in the phone; the start of the number first, then the last digits (last 4) or the local
// number (after the area code), then anywhere else. Letters: every typed word starts one of the person's name
// words (first or last name, or a hotel's name), case and accents ignored. Ties: the most recently seen first.
// Each result: { entry, phoneParts, nameParts } ready to show.
export function matchPeople(index, text, max = 6) {
  const { kind, q } = lookupQuery(text);
  if (!kind || !index?.length) return [];
  const hits = [];
  for (const e of index) {
    if (kind === 'digits') {
      const at = e.phone.indexOf(q);
      if (at < 0) continue;
      const rank = at === 0 ? 0 : (at + q.length === e.phone.length || at === 3) ? 1 : 2;
      hits.push({ e, rank, at, len: q.length });
    } else {
      const all = [...(e.names || []), e.name].filter(Boolean);
      const mine = words(all.join(' '));
      if (!q.every((t) => mine.some((w) => w.startsWith(t)))) continue;
      const best = words(e.name);
      const rank = best.length && q.every((t) => best.some((w) => w.startsWith(t))) ? (best[0].startsWith(q[0]) ? 0 : 1) : 2;
      hits.push({ e, rank, at: -1, len: 0 });
    }
  }
  hits.sort((a, b) => a.rank - b.rank || (a.e.last < b.e.last ? 1 : a.e.last > b.e.last ? -1 : 0) || a.e.phone.localeCompare(b.e.phone));
  return hits.slice(0, max).map((h) => ({
    entry: h.e,
    phoneParts: highlightPhone(h.e.phone, h.at, h.len),
    nameParts: kind === 'name' ? highlightName(h.e.name, q) : [{ text: h.e.name, hit: false }],
  }));
}
