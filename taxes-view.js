// Taxes tab (version 1.27.0, owner only): draws the month's sales tax numbers (worked out in taxes.js)
// and the CSV download. dashboard.js calls renderTaxes when the tab is open; employee (kitchen)
// logins never get here (dashboard.js keeps them on Dough, and taxes.css hides the tab for them).
import { closedMonths, monthLabel, taxMonth, taxCsv } from './taxes.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const money = (c) => (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let month = '';
let memo = { data: null, month: '', today: '' };
let last = null; // the month on screen, for the download

const notYet = (why) => `<span class="tx-na">Not available yet</span>${why ? `<small>${esc(why)}</small>` : ''}`;
const notStored = (why) => `<span class="tx-dash">Not stored</span>${why ? `<small>${esc(why)}</small>` : ''}`;
const chip = (confirmed) => (confirmed ? '' : '<span class="tx-chip">not confirmed</span>');

function taxCell(r) {
  if (r.tax.cents != null) return `<b>${money(r.tax.cents)}</b>${r.tax.from ? `<small>${esc(r.tax.from)}</small>` : ''}`;
  let why = r.tax.why;
  if (r.tax.cardHint) why += `. Card payments alone carried about ${money(r.tax.cardHint.cents)} of tax on those days (worked out from what cards were charged); cash tax isn't stored for them`;
  return notYet(why);
}
const tipsCell = (r) => (r.tips.cents != null ? `<b>${money(r.tips.cents)}</b><small>not sales</small>` : r.id === 'instore' || r.id === 'owner' ? notYet(r.tips.why) : notStored(r.tips.why));
const discCell = (r) => (r.discounts.cents != null ? `<b>${money(r.discounts.cents)}</b>` : notStored(r.discounts.why));
function keptCell(r) {
  if (r.kept.none) return `<span class="tx-dash">None</span><small>${esc(r.kept.why)}</small>`;
  if (r.kept.cents != null) return `<b>${money(r.kept.cents)}</b>${r.kept.what ? `<small>${esc(r.kept.what)}</small>` : ''}`;
  return notYet(r.kept.why);
}
const whoCell = (r) => `<b>${esc(r.who.who)}</b>${chip(r.who.confirmed)}`;

const COLS = [
  ['Orders', (r) => `<b>${r.orders.toLocaleString('en-US')}</b>`],
  ['Sales before fees', (r) => `<b>${money(r.sales)}</b>`],
  ['Discounts', discCell],
  ['Sales tax collected', taxCell],
  ['Tips', tipsCell],
  ['Fees the app kept', keptCell],
  ['Who sends the sales tax to the state', whoCell],
];

function table(t) {
  const head = `<tr><th scope="col">Channel</th>${COLS.map(([h]) => `<th scope="col">${esc(h)}</th>`).join('')}</tr>`;
  const body = t.rows.map((r) => `<tr><th scope="row"><b>${esc(r.name)}</b>${r.note ? `<small>${esc(r.note)}</small>` : ''}${
    r.notes.map((n) => `<small class="tx-warn">${esc(n)}</small>`).join('')}</th>${COLS.map(([, f]) => `<td>${f(r)}</td>`).join('')}</tr>`).join('');
  const T = t.total;
  const tot = (f) => (f.cents != null ? `<b>${money(f.cents)}</b>` : `<span class="tx-na">Not complete</span><small>${esc(f.missing.join(', '))} missing</small>`);
  const foot = `<tr><th scope="row"><b>All channels</b></th><td><b>${T.orders.toLocaleString('en-US')}</b></td><td><b>${money(T.sales)}</b></td>
    <td><b>${money(T.discounts.known)}</b><small>where stored</small></td><td>${tot(T.tax)}</td><td>${tot(T.tips)}</td>
    <td>${T.kept.cents != null ? `<b>${money(T.kept.cents)}</b>` : `<b>${money(T.kept.known)}</b><small>where stored</small>`}</td><td></td></tr>`;
  return `<div class="tx-wide"><table class="tx-table"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>`;
}

// phones: one card per channel, label on the left, number on the right
function cards(t) {
  const one = (r) => `<article class="tx-card"><h3>${esc(r.name)}${r.note ? ` <span>${esc(r.note)}</span>` : ''}</h3>
    <dl>${COLS.map(([h, f]) => `<div><dt>${esc(h)}</dt><dd>${f(r)}</dd></div>`).join('')}</dl>
    ${r.notes.map((n) => `<p class="tx-warn">${esc(n)}</p>`).join('')}</article>`;
  const T = t.total;
  return `<div class="tx-narrow">${t.rows.map(one).join('')}<article class="tx-card tx-card-total"><h3>All channels</h3><dl>
    <div><dt>Orders</dt><dd><b>${T.orders.toLocaleString('en-US')}</b></dd></div>
    <div><dt>Sales before fees</dt><dd><b>${money(T.sales)}</b></dd></div>
    <div><dt>Sales tax collected</dt><dd>${T.tax.cents != null ? `<b>${money(T.tax.cents)}</b>` : `<span class="tx-na">Not complete</span><small>${esc(T.tax.missing.join(', '))} missing</small>`}</dd></div>
    <div><dt>Tips</dt><dd>${T.tips.cents != null ? `<b>${money(T.tips.cents)}</b>` : `<span class="tx-na">Not complete</span><small>${esc(T.tips.missing.join(', '))} missing</small>`}</dd></div>
  </dl></article></div>`;
}

function stateBox(t) {
  const S = t.state;
  const storeTax = S.storeTax != null ? `<b class="tx-big">${money(S.storeTax)}</b>`
    : `<b class="tx-big tx-na">Not available yet</b><small>Missing for ${esc(S.storeTaxMissing.join(', '))}. See the table below.</small>`;
  return `<section class="tx-state" aria-labelledby="txStateTitle">
    <h2 id="txStateTitle">Numbers for the state return</h2>
    <div class="tx-state-grid">
      <div class="tx-num"><span>Total sales, all channels</span><b class="tx-big">${money(S.totalSales)}</b>
        <small>Your own sales (${esc(S.yourNames.join(', '))}): ${money(S.yourSales)}</small></div>
      <div class="tx-num"><span>Sales the apps already handled tax on</span><b class="tx-big">${money(S.appSales)}</b>
        <small>${esc(S.appNames.join(', '))}</small>${chip(S.appsConfirmed)}</div>
      <div class="tx-num tx-num-main"><span>Sales tax the store itself collected</span>${storeTax}
        <small>On ${esc(S.yourNames.join(', '))}</small>${chip(S.storeTaxConfirmed)}</div>
    </div>
  </section>`;
}

function body(t, months) {
  const opts = months.map((m) => `<option value="${m}"${m === t.month ? ' selected' : ''}>${esc(monthLabel(m))}</option>`).join('');
  const missing = t.missingDays.length
    ? `<p class="tx-alert">${t.missingDays.length} day${t.missingDays.length === 1 ? '' : 's'} of ${esc(t.label)} have no numbers kept for at least one channel (${esc(t.missingDays.slice(0, 3).join(', '))}${t.missingDays.length > 3 ? ', ...' : ''}). The totals leave them out.</p>` : '';
  return `<div class="tx-top">
      <div class="tx-title"><h1>Sales tax</h1><p>${esc(t.label)}, every channel, for the state's monthly return</p></div>
      <div class="tx-controls">
        <label class="tx-pick"><span>Month</span><select id="txMonth" aria-label="Month">${opts}</select></label>
        <button class="tx-btn" type="button" id="txCsv">Download this month (CSV)</button>
      </div>
    </div>
    <ul class="tx-lines">
      <li>Recent days can still change. File from a month that has ended.</li>
      <li>Check these with your accountant before filing.</li>
    </ul>
    ${missing}
    ${stateBox(t)}
    <section class="tx-channels" aria-label="By channel"><h2>By channel</h2>${table(t)}${cards(t)}</section>
    <section class="tx-how"><h2>Where these numbers come from</h2><ul>
      <li><b>Sales</b> are the same as on the Sales tab: before tax and tips, after discounts, cancelled orders left out.</li>
      <li><b>In-store tax and tips</b> are what Clover recorded on each card and cash payment, less the tax on refunds.</li>
      <li><b>Website and app tax and tips</b> are what Clover recorded on its copy of these orders (External Payment).</li>
      <li><b>DoorDash, Uber Eats and Grubhub</b>: their tax and tips are not read yet. "Fees the app kept" is the sales less what the app paid you.</li>
      <li><b>Who sends the sales tax</b> is set in the add-on's settings (config.js, salesTaxBy). "Not confirmed" means it hasn't been checked yet.</li>
      <li>Months are calendar months in Pacific time.</li>
    </ul></section>`;
}

// who = CONFIG.salesTaxBy (who sends each channel's tax)
export function renderTaxes(root, data, today, who) {
  if (!root) return;
  const months = closedMonths(today);
  if (!months.length) { root.innerHTML = '<div class="tx-top"><div class="tx-title"><h1>Sales tax</h1><p>No month has ended yet.</p></div></div>'; return; }
  if (!months.includes(month)) month = months[0]; // the last month that has ended
  if (memo.data === data && memo.month === month && memo.today === today) return; // nothing changed: leave the page alone
  memo = { data, month, today };
  last = { t: taxMonth(data, month, who || {}), data };
  root.innerHTML = body(last.t, months);
}

// the month picker and the download (set up once)
export function wireTaxes(root, rerender) {
  root.addEventListener('change', (e) => {
    if (e.target.id !== 'txMonth') return;
    month = e.target.value;
    rerender();
    document.getElementById('txMonth')?.focus({ preventScroll: true });
  });
  root.addEventListener('click', (e) => {
    if (!e.target.closest('#txCsv') || !last) return;
    const blob = new Blob([taxCsv(last.t, last.data)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Can Am sales tax ${last.t.month}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
}
