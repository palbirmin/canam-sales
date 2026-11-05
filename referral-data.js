// Referral cards (version 1.14.0; counter tablet 1.16.0): reading and saving, through Supabase's REST API as
// the signed-in login. The tables, their rules and the views are in phone/supabase_referral.sql and
// supabase_referral_tiers.sql. referral-demo.js has the same functions over made-up data, for trying the page
// on this computer without signing in.

import { personalRows } from './referral-logic.js';
import { dayKeyOf, dayBounds } from './lib.js';

// PostgREST gives a one-to-one embed as an object or as a one-item list, depending on its version.
const one = (x) => (Array.isArray(x) ? x[0] || null : x || null);

export function makeReferralStore(supa) {
  const get = (q) => supa.rest('GET', q);

  return {
    demo: false,

    // Everything about one card: its hand-out (and hotel batch), its redemption, and where it came from.
    async cardInfo(n) {
      const [cards, reds, chain] = await Promise.all([
        get(`referral_cards?select=card_no,given_on,referrer_name,referrer_phone,batch_id,notes,by_name,referral_batches(label,phone,card_from,card_to,given_on)&card_no=eq.${n}`),
        get(`referral_redemptions?select=id,card_no,new_name,new_phone,redeemed_on,by_name,warnings,override_note&card_no=eq.${n}`),
        get(`referral_chain?select=came_from_card&card_no=eq.${n}`),
      ]);
      const card = cards[0] ? { ...cards[0], batch: one(cards[0].referral_batches) } : null;
      return { card, redemption: reds[0] || null, cameFrom: chain[0]?.came_from_card ?? null };
    },

    // Everything about one phone number: cards it redeemed (and who handed them out), cards handed to it
    // (and who redeemed them), and its breadsticks.
    async phoneHistory(p) {
      const [reds, cards, rewards] = await Promise.all([
        get(`referral_redemptions?select=card_no,new_name,redeemed_on,referral_cards(referrer_name,referrer_phone,batch_id,given_on)&new_phone=eq.${p}&order=redeemed_on.asc`),
        get(`referral_cards?select=card_no,given_on,referrer_name,batch_id,referral_redemptions(new_name,new_phone,redeemed_on)&referrer_phone=eq.${p}&batch_id=is.null&order=given_on.asc`),
        get(`referral_rewards?select=id,kind,earned_from_card,earned_on,given_on,given_by,given_by_name&phone=eq.${p}&order=earned_on.asc,id.asc`),
      ]);
      return {
        redeemed: reds.map((r) => ({ ...r, card: one(r.referral_cards) })),
        handedOut: cards.map((c) => ({ ...c, redemption: one(c.referral_redemptions) })),
        rewards,
      };
    },

    // A hand-out row from the paper log. exists = the card already has a row (replace or fill in).
    async saveHandout(row, exists) {
      const body = { given_on: row.given_on, referrer_name: row.referrer_name, referrer_phone: row.referrer_phone };
      if (exists) await supa.rest('PATCH', `referral_cards?card_no=eq.${row.card_no}`, body, 'return=minimal');
      else await supa.rest('POST', 'referral_cards', [{ card_no: row.card_no, ...body }], 'return=minimal');
    },

    async saveBatch(row) {
      await supa.rest('POST', 'referral_batches', [row], 'return=minimal');
    },

    // Several cards for one person (the batch form's "Person"): one ordinary hand-out row per card, so each
    // one redeemed earns them breadsticks. Refused if any card in the range is already logged.
    async savePersonalBatch(row) {
      const taken = await get(`referral_cards?select=card_no&card_no=gte.${row.card_from}&card_no=lte.${row.card_to}&order=card_no.asc`);
      if (taken.length) throw new Error(`These cards are already logged: ${taken.map((c) => String(c.card_no).padStart(4, '0')).join(', ')}`);
      await supa.rest('POST', 'referral_cards', personalRows(row), 'return=minimal');
    },

    // Phones not yet added to Owner.com rewards, oldest first; and ticking them off.
    async signupList() {
      return get('referral_rewards_signup?select=phone,name,sources,first_seen&order=first_seen.asc');
    },
    async markAdded(phones) {
      await supa.rest('POST', 'rpc/referral_mark_added', { phones }, 'return=minimal');
    },

    async saveRedemption(row) {
      await supa.rest('POST', 'referral_redemptions', [{ ...row, discount_applied: true }], 'return=minimal');
    },

    async giveReward(id, day) {
      await supa.rest('PATCH', `referral_rewards?id=eq.${id}&given_on=is.null`, { given_on: day }, 'return=minimal');
    },

    // Breadsticks owed right now, oldest first, with the name on the hand-out.
    async owed() {
      const rows = await get('referral_rewards?select=id,phone,earned_from_card,earned_on,referral_cards(referrer_name)&given_on=is.null&order=earned_on.asc,id.asc&limit=200');
      return rows.map((r) => ({ ...r, name: one(r.referral_cards)?.referrer_name || '' }));
    },

    async hotelCounts() {
      return get('referral_hotel_counts?select=label,cards_given,redemptions,lunches_earned,to_next_lunch,lunches_delivered,lunches_owed&order=label.asc');
    },

    // ---------- version 1.16.0: the counter tablet ----------

    // The signed-in login's id (the "sub" in its access token), to tell its own entries from others'.
    async whoAmI() {
      const s = await supa.session();
      try {
        const b64 = s.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return { id: JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))).sub || null };
      } catch { return { id: null }; }
    },

    // Keeps the sign-in fresh (supa.js renews the access token when it's close to running out).
    async ping() { await get('dashboard_users?select=user_id&limit=1'); },

    // Cards turned in today (store day), for the home screen.
    async todayCount(day) {
      return (await get(`referral_redemptions?select=id&redeemed_on=eq.${day}`)).length;
    },

    // Every front-desk lunch delivered, per hotel in order.
    async hotelLunches() {
      return get('referral_hotel_lunches?select=id,label,lunch_no,delivered_on,delivered_by,delivered_by_name,created_at&order=label.asc,lunch_no.asc');
    },
    async deliverLunch(row) {
      await supa.rest('POST', 'referral_hotel_lunches', [{ label: row.label, lunch_no: row.lunch_no, delivered_on: row.delivered_on }], 'return=minimal');
    },

    // Take back one entry (referral_undo in supabase_referral_tiers.sql). what = 'redemption' | 'handout'
    // (id = card number), 'batch' | 'lunch' | 'reward' (id = row id). Refused with a message when not allowed.
    async undo(what, id) {
      await supa.rest('POST', 'rpc/referral_undo', { what, id: Number(id) }, 'return=minimal');
    },

    // Everything entered today (store day), newest first, in one shape:
    // { what, id, at, day, by, by_name, row } (by = the login that entered it). The page shows a login its own.
    async todayEntries(day) {
      const since = new Date(dayBounds(day)[0]).toISOString();
      const enc = encodeURIComponent(since);
      const [reds, cards, batches, lunches, rewards] = await Promise.all([
        get(`referral_redemptions?select=id,card_no,new_name,new_phone,redeemed_on,created_by,by_name,created_at&created_at=gte.${enc}&order=created_at.desc`),
        get(`referral_cards?select=card_no,given_on,referrer_name,referrer_phone,created_by,by_name,created_at&batch_id=is.null&given_on=not.is.null&created_at=gte.${enc}&order=created_at.desc`),
        get(`referral_batches?select=id,label,card_from,card_to,given_on,created_by,by_name,created_at&created_at=gte.${enc}&order=created_at.desc`),
        get(`referral_hotel_lunches?select=id,label,lunch_no,delivered_on,delivered_by,delivered_by_name,created_at&created_at=gte.${enc}&order=created_at.desc`),
        get(`referral_rewards?select=id,phone,kind,earned_from_card,given_on,given_by,given_by_name&given_on=eq.${day}&order=id.desc`),
      ]);
      const at = (x) => ({ at: x.created_at, day: dayKeyOf(Date.parse(x.created_at)) });
      return [
        ...reds.map((r) => ({ what: 'redemption', id: r.card_no, ...at(r), by: r.created_by, by_name: r.by_name, row: r })),
        ...cards.map((c) => ({ what: 'handout', id: c.card_no, ...at(c), by: c.created_by, by_name: c.by_name, row: c })),
        ...batches.map((b) => ({ what: 'batch', id: b.id, ...at(b), by: b.created_by, by_name: b.by_name, row: b })),
        ...lunches.map((l) => ({ what: 'lunch', id: l.id, ...at(l), by: l.delivered_by, by_name: l.delivered_by_name, row: l })),
        ...rewards.map((w) => ({ what: 'reward', id: w.id, at: '', day: w.given_on, by: w.given_by, by_name: w.given_by_name, row: w })),
      ].filter((x) => x.day === day).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    },

    // The latest entries by anyone: redeemed cards, hand-outs and hotel batches, newest first.
    async recent() {
      const [reds, cards, batches] = await Promise.all([
        get('referral_redemptions?select=card_no,new_name,new_phone,redeemed_on,by_name,created_at,warnings&order=created_at.desc&limit=15'),
        get('referral_cards?select=card_no,given_on,referrer_name,referrer_phone,by_name,created_at&batch_id=is.null&given_on=not.is.null&order=created_at.desc&limit=15'),
        get('referral_batches?select=label,card_from,card_to,given_on,by_name,created_at&order=created_at.desc&limit=5'),
      ]);
      return [
        ...reds.map((r) => ({ kind: 'redeemed', ...r })),
        ...cards.map((c) => ({ kind: 'handout', ...c })),
        ...batches.map((b) => ({ kind: 'batch', ...b })),
      ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 12);
    },
  };
}

// True when the error says the referral tables aren't in the database yet (supabase_referral.sql not run).
export const missingTables = (e) => /does not exist|could not find the (table|relation)|schema cache|PGRST20[0-9]/i.test(String(e?.message || e));
