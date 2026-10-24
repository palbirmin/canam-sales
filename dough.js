// How many pizza doughs each item used: Medium (M), Large (L) and Extra Large (X).
// Pizzas use the dough of their size, deals count the pizzas inside them, and calzones and
// every kind of breadsticks use a medium dough.
//
// Clover records every order from every app (in-store, DoorDash and Uber Eats through OrderOut,
// Grubhub, the website as External Payment) with the size picked for each pizza, so doughs are
// counted from there (doughForLine). Gluten-free crusts use a different dough and aren't counted.
// Where no size was picked (the apps' own item reports, or an item without one), a specialty
// pizza's size is worked out from its price: each size has its own price, and extra toppings only
// add a little. Checked on Sep 25–Oct 20, 2026: the price guess came within about 2% of Clover's sizes.

// Same spelling for every app: "12pcs Cheesy Bread Sticks" / "12 Pieces Cheesy Bread Sticks", "Jalapeño" / "Jalapeno".
export const doughName = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/(\d+)\s*pcs?\b/g, '$1 pieces').replace(/\bpcs?\b/g, 'pieces')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// Base prices in cents for [Medium, Large, Extra Large]. In-store, the website & app and the
// 2-pizza deals use the menu prices; DoorDash, Uber Eats and Grubhub charge more, and changed
// their prices on 2026-10-06. If the apps change prices again, add a new line here.
const STORE = { reg: [1999, 2299, 2799], gourmet: [2199, 2499, 2999], halal: [2099, 2499, 2899] };
const APP_PRICES = [
  { from: '2026-10-06', reg: [2299, 2644, 3144], gourmet: [2529, 2874, 3449], halal: [2399, 2849, 3199] },
  { from: '', reg: [2399, 2699, 2999], gourmet: [2599, 2899, 3199], halal: [2499, 2899, 3299] },
];
const DEALS = { two: [3399, 3899, 4599], gourmet: [3599, 4199, 4799], halal: [3399, 4099, 4799] };
const APPS = new Set(['doordash', 'uber', 'grubhub']);
const TOPPINGS = 60; // what extra toppings add to a pizza, on average (cents)

const ladder = (tier, ch, day) => (APPS.has(ch) ? APP_PRICES.find((p) => day >= p.from)[tier] : STORE[tier]);
const tierOf = (n) => (/\bhalal\b/.test(n) ? 'halal' : /\b(gyros pizza|pesto|mega|ultimate|primo|taco supreme|shrimp)\b/.test(n) ? 'gourmet' : 'reg');

// Splits qty pizzas that cost `cents` in all into sizes: the mix whose menu prices (plus a
// little for toppings) come closest to what was paid. A mix whose menu prices add up to more
// than was paid can't be right, unless nothing fits (a discount); then the cheapest mix wins.
function bySize(qty, cents, prices, perUnit = 1) {
  let best = null;
  for (let m = 0; m <= qty; m++) {
    for (let l = 0; l <= qty - m; l++) {
      const x = qty - m - l;
      const base = m * prices[0] + l * prices[1] + x * prices[2];
      const over = base > cents + 10 * qty;
      const miss = Math.abs(cents - base - TOPPINGS * qty);
      if (!best || (over ? best.over && base < best.base : best.over || miss < best.miss)) best = { over, miss, base, m, l, x };
    }
  }
  return { M: best.m * perUnit, L: best.l * perUnit, X: best.x * perUnit };
}
const NOT_SOLD = 1e7; // a size this item doesn't come in

// [pattern, rule, sized]. The first pattern that matches the item name wins. A rule is fixed counts
// per item sold ({ M: 2 }), 'none', or a function (qty, cents, channel, day, name) -> { M, L, X }.
// sized = the customer picks the size, so Clover's size choice is used when there is one.
// Checked with the owner on 2026-10-21: only Medium, Large and XL doughs; the prices above are right.
const RULES = [
  // never pizza dough, even with "pizza" or "cheese" in the name (garlic bread and the
  // pizza cookies don't use pizza dough either)
  [/\b(dip|cookie|mozzarella|tortellini|party tray|gluten free|delivery fee|custom item|pizza sub|garlic bread)\b/, 'none'],

  // deals: the pizzas inside them
  [/\b2 large 2 toppings? pizzas?\b/, { L: 2 }],
  [/\b2 medium 2 toppings? pizzas?\b/, { M: 2 }],
  [/^2 (specialty|indian|indian specialty|gourmet|gourmet and all|halal) pizzas?( deal)?$/, (q, c, ch, day, n) =>
    bySize(q, c, DEALS[/gourmet/.test(n) ? 'gourmet' : /halal/.test(n) ? 'halal' : 'two'], 2), true],
  // a large or extra-large specialty pizza, plus a free medium cheese pizza
  [/\bbuy 1 and get 1\b/, (q, c, ch, day) => {
    const s = bySize(q, c, [NOT_SOLD, ...ladder('reg', ch, day).slice(1)]);
    return { ...s, M: s.M + q };
  }, true],
  [/\blarge pickup special\b/, { L: 1 }],
  // the cheese sticks in these deals are the 12 cheesy breadsticks: a medium dough
  [/\blarge (pizza|pepperoni or cheese pizza) and cheese ?sticks\b|\blarge pepperoni or cheese pizza\b/, { L: 1, M: 1 }],
  [/^large pizza\b/, { L: 1 }], // with chicken tenders or wings
  [/\bmedium pizza (and pasta|combo)\b/, { M: 1 }],
  // Catering packages aren't counted for dough (decided with the owner on 2026-10-21). To count
  // catering again, count its pizzas here (from the menu: 1 and 2 = 4 large, 3 = 5 large + 2 medium,
  // 4 = 6 large + 2 medium, 5 = 6 large + 3 medium, 6 = 8 large + 5 medium).
  [/\bcatering package\b/, 'none'],

  // medium dough
  [/\bcalzone\b/, { M: 1 }],
  [/\b(bread ?sticks|cheese sticks)\b/, { M: 1 }],
  [/\bcheesy curry bites\b/, { M: 1 }],
  [/\b8 (inch )?pizza lunch special\b/, { M: 1 }],

  // subs, gyros, wraps, salads and pastas (and their specials)
  [/\b(sub|subs|gyro|gyros|wrap|wraps|salad|pasta|lasagna|spaghetti|ravioli|fettuccini|fettuccine|penne)\b(?! pizza)/, 'none'],

  // pizzas with the size in the name
  [/\b(x large|extra large)\b/, { X: 1 }],
  [/\blarge\b/, { L: 1 }],
  [/\bmedium\b/, { M: 1 }],

  // a specialty pizza: size from the price
  [/\bpizza$/, (q, c, ch, day, n) => bySize(q, c, ladder(tierOf(n), ch, day)), true],
];

// Everything else on the menu (drinks, wings, tenders, chips, extra toppings rung up on their own...) uses no dough.
const NO_DOUGH = /\b(can|cans|bottle|liter|litre|water|celsius|pepsi|chips|cheetos|bag of|wings|tenders|halal chicken|extra|bacon and tomatoes)\b/;

// { M, L, X } for one item line, or null when it uses no dough. `known` is false for a
// name none of the rules recognise (counted as no dough, and listed so it can be added).
export function doughFor(name, qty, cents, channel, day) {
  const n = doughName(name);
  for (const [re, rule] of RULES) {
    if (!re.test(n)) continue;
    if (rule === 'none') return null;
    const per = typeof rule === 'function' ? rule(qty, cents, channel, day, n) : { M: (rule.M || 0) * qty, L: (rule.L || 0) * qty, X: (rule.X || 0) * qty };
    return { M: per.M || 0, L: per.L || 0, X: per.X || 0, known: true };
  }
  return NO_DOUGH.test(n) ? null : { M: 0, L: 0, X: 0, known: false };
}

// Doughs for one channel's item list { name: [quantity, cents] } on one day.
export function doughOfItems(items, channel, day) {
  const out = { M: 0, L: 0, X: 0, unknown: [] };
  for (const [name, [qty, cents]] of Object.entries(items || {})) {
    const d = doughFor(name, qty, cents, channel, day);
    if (!d) continue;
    if (!d.known) out.unknown.push(name);
    out.M += d.M; out.L += d.L; out.X += d.X;
  }
  return out;
}

// ---------- from Clover orders, with the size the customer picked ----------
// Size choices as Clover shows them: "Medium 12\"", "Large 14\" 22.99", "X-Large 16\"", and in the
// 2-pizza deals "Both Large 38.99".
const SIZE_CHOICES = [
  [/\bboth (extra large|x-?large)\b/i, 'X', 2], [/\bboth large\b/i, 'L', 2], [/\bboth medium\b/i, 'M', 2],
  [/\b(x-?large|extra large) ?16/i, 'X', 1], [/\blarge 14/i, 'L', 1], [/\bmedium 12/i, 'M', 1],
];

// { M, L, X, known, gf? } for one Clover line item (one item sold), or null when it uses no dough.
export function doughForLine(name, mods, cents, channel, day) {
  const n = doughName(name);
  for (const [re, rule, sized] of RULES) {
    if (!re.test(n)) continue;
    if (rule === 'none') return null;
    if (mods.some((m) => /gluten free/i.test(m))) return { M: 0, L: 0, X: 0, known: true, gf: true };
    if (sized) {
      const got = { M: 0, L: 0, X: 0 };
      let picked = false;
      for (const m of mods) {
        const hit = SIZE_CHOICES.find(([mre]) => mre.test(m));
        if (hit) { got[hit[1]] += hit[2]; picked = true; }
      }
      if (picked) {
        if (/\bbuy 1 and get 1\b/.test(n)) got.M += 1; // the free medium cheese pizza
        return { ...got, known: true };
      }
    }
    return doughFor(name, 1, cents, channel, day);
  }
  return NO_DOUGH.test(n) ? null : { M: 0, L: 0, X: 0, known: false };
}

// One day's doughs from its Clover orders, in 15-minute slots so it's known when they were used:
// { v, s: [[slot, M, L, X], ...], gf, n, unknown }. orders = [{ minute, channel, lines: [{ name,
// mods: [names], cents }] }], channel being 'instore', 'doordash', 'uber', 'owner' or 'grubhub'.
export const DOUGH_DAY_VERSION = 1;
export const DOUGH_KEEP_DAYS = 200; // dough days are kept about 6 months, to learn from
export function doughOfOrders(orders, day) {
  const slots = new Map();
  let gf = 0;
  const unknown = new Set();
  for (const o of orders) {
    const slot = Math.max(0, Math.min(95, Math.floor(o.minute / 15)));
    for (const li of o.lines) {
      const d = doughForLine(li.name, li.mods, li.cents, o.channel, day);
      if (!d) continue;
      if (d.gf) gf += 1;
      if (!d.known) unknown.add(li.name);
      if (!(d.M || d.L || d.X)) continue;
      const x = slots.get(slot) || [slot, 0, 0, 0];
      x[1] += d.M; x[2] += d.L; x[3] += d.X;
      slots.set(slot, x);
    }
  }
  return { v: DOUGH_DAY_VERSION, s: [...slots.values()].sort((a, b) => a[0] - b[0]), gf, n: orders.length, unknown: [...unknown] };
}
