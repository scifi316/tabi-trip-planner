// Money: shared and private expenses, who owes whom, receipts with OCR, settle-up payments.
import { state, on, op, api, emit, userById, groupById, groupsOn, myGroupOn, today, tripDays, livePlaces } from './store.js';
import { esc, icon, avatar, openSheet, toast, fmtDay, uid, confirmSheet, debounce } from './ui.js';
import { meButton } from './main.js';

const DIGITS = { JPY: 0, KRW: 0, VND: 0, IDR: 0 };
const digits = (c) => DIGITS[c] ?? 2;
const base = () => state.trip.currency || 'JPY';
const CATS = {
  food: { label: 'Food & drink', glyph: '食' }, transport: { label: 'Transport', glyph: '交' }, lodging: { label: 'Stay', glyph: '宿' },
  activities: { label: 'Activities', glyph: '遊' }, shopping: { label: 'Shopping', glyph: '買' }, other: { label: 'Other', glyph: '他' },
};

// ---------- money maths (integers in minor units) ----------
export function fmt(minor, currency = base(), { sign = false } = {}) {
  const d = digits(currency);
  const v = minor / 10 ** d;
  const s = new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(Math.abs(v));
  return (sign && v > 0 ? '+' : v < 0 ? '−' : '') + s;
}
const toMinor = (major, currency) => Math.round(+String(major).replace(/[^\d.\-]/g, '') * 10 ** digits(currency));
const toMajor = (minor, currency) => (minor / 10 ** digits(currency)).toFixed(digits(currency));
const inBase = (minor, e) => Math.round(minor * e.rate * 10 ** (digits(base()) - digits(e.currency)));

// Split `total` across weights so the parts are whole numbers that add up exactly (largest remainder).
export function allocate(total, weights) {
  const w = weights.map((x) => Math.max(0, x));
  const sum = w.reduce((a, b) => a + b, 0);
  if (!sum) return allocate(total, weights.map(() => 1));
  const raw = w.map((x) => (total * x) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

const visibleExpenses = () => [...state.expenses.values()].filter((e) => !e.deletedAt);

// Pairwise debts in trip currency: owes[a][b] = how much a owes b.
export function ledger(expenses = visibleExpenses()) {
  const net = {};
  const owes = {};
  const add = (a, b, v) => { (owes[a] ||= {})[b] = (owes[a]?.[b] || 0) + v; };
  for (const e of expenses) {
    for (const s of e.shares) {
      const v = inBase(s.amount, e);
      net[e.paidBy] = (net[e.paidBy] || 0) + v;
      net[s.userId] = (net[s.userId] || 0) - v;
      if (s.userId !== e.paidBy) add(s.userId, e.paidBy, v);
    }
  }
  const pair = (a, b) => (owes[a]?.[b] || 0) - (owes[b]?.[a] || 0); // >0: a owes b
  return { net, pair };
}

// Fewest transfers that settle everyone's net balance.
export function settlePlan(net) {
  const cred = [], debt = [];
  for (const [id, v] of Object.entries(net)) {
    if (v > 0) cred.push([+id, v]); else if (v < 0) debt.push([+id, -v]);
  }
  cred.sort((a, b) => b[1] - a[1]); debt.sort((a, b) => b[1] - a[1]);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const x = Math.min(debt[i][1], cred[j][1]);
    if (x > 0) out.push({ from: debt[i][0], to: cred[j][0], amount: x });
    debt[i][1] -= x; cred[j][1] -= x;
    if (!debt[i][1]) i++;
    if (!cred[j][1]) j++;
  }
  return out;
}

// ---------- screen ----------
const root = () => document.getElementById('screen-money');
let tab = 'expenses';
let filter = 'all';
let withUser = null; // show only expenses between me and this person
on('money-with', (id) => { withUser = +id; tab = 'expenses'; filter = 'all'; if (isShown()) render(); });
const isShown = () => !root().hidden;
['expenses', 'users', 'trip', 'subgroups'].forEach((e) => on(e, () => isShown() && render()));

export function showMoney() { render(); }

export function render() {
  const el = root();
  const me = state.me?.id;
  const all = visibleExpenses();
  const { net, pair } = ledger(all);
  const myNet = net[me] || 0;
  const people = state.users.filter((u) => u.id !== me)
    .map((u) => ({ u, v: pair(u.id, me) })) // >0: they owe me
    .filter((x) => Math.abs(x.v) >= 1);
  if (withUser && !userById(withUser)) withUser = null;
  const between = (e) => (e.paidBy === me && e.shares.some((s) => s.userId === withUser)) || (e.paidBy === withUser && e.shares.some((s) => s.userId === me));
  const shown = all.filter((e) => !withUser || between(e)).filter((e) => filter === 'all' ? true : filter === 'mine' ? (e.paidBy === me || e.shares.some((s) => s.userId === me)) : filter === 'private' ? e.visibility === 'private' : e.kind === 'payment')
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt);
  const byDate = {};
  for (const e of shown) (byDate[e.date || ''] ||= []).push(e);
  const totalSpent = all.filter((e) => e.kind === 'expense').reduce((a, e) => a + inBase(e.amount, e), 0);

  el.innerHTML = `
  <div class="page">
    <header class="page-head">${meButton()}
      <div class="grow"><h1>Money</h1><div class="sub">Trip currency ${esc(base())}${totalSpent ? `, ${fmt(totalSpent)} spent so far` : ''}</div></div>
      <button class="btn small primary" data-add>${icon('plus')}Expense</button>
    </header>

    ${withUser ? (() => {
      const w = userById(withUser), v = pair(withUser, me);
      return `<div class="person-banner">${avatar(w)}<span class="grow">Showing expenses between you and <b>${esc(w.name)}</b>.
        ${v > 0 ? `${esc(w.name)} owes you <b class="num pos">${fmt(v)}</b>.` : v < 0 ? `You owe ${esc(w.name)} <b class="num neg">${fmt(-v)}</b>.` : 'You’re all square.'}</span>
        ${v ? `<button class="btn small primary" data-settle="${withUser}" data-amount="${v}">${v > 0 ? 'Record payment' : 'Settle up'}</button>` : ''}
        <button class="btn small" data-clear-with>Show all</button></div>`;
    })() : ''}
    <section class="money-summary" ${withUser ? 'hidden' : ''}>
      <div class="money-big ${myNet > 0 ? 'pos' : myNet < 0 ? 'neg' : ''}">
        <span class="label">${myNet > 0 ? 'You are owed' : myNet < 0 ? 'You owe' : 'You’re all square'}</span>
        ${myNet ? `<b class="num">${fmt(Math.abs(myNet))}</b>` : ''}
      </div>
      ${people.length ? `<div class="owe-list">${people.map(({ u, v }) => `
        <div class="owe-row">${avatar(u)}<div class="grow"><b>${esc(u.name)}</b> ${v > 0 ? 'owes you' : 'is owed'} <span class="num ${v > 0 ? 'pos' : 'neg'}">${fmt(Math.abs(v))}</span></div>
          <button class="btn small" data-settle="${u.id}" data-amount="${v}">${v > 0 ? 'Record payment' : 'Settle up'}</button></div>`).join('')}</div>` : ''}
    </section>

    <div class="seg" role="group" style="margin:0 14px 12px">
      <button data-tab="expenses" aria-pressed="${tab === 'expenses'}">Expenses</button>
      <button data-tab="balances" aria-pressed="${tab === 'balances'}">Group balances</button>
    </div>

    ${tab === 'expenses' ? `
      <div class="chips" role="group" aria-label="Filter expenses">
        ${[['all', 'All'], ['mine', 'Involving me'], ['private', 'Private'], ['payments', 'Payments']].map(([k, l]) => `<button class="chip" data-filter="${k}" aria-pressed="${filter === k}">${k === 'private' ? icon('lock', 'small') : ''}${l}</button>`).join('')}
      </div>
      ${shown.length ? Object.entries(byDate).map(([d, list]) => `
        <section class="group"><div class="group-head"><h3>${d ? esc(fmtDay(d, { weekday: 'short', day: 'numeric', month: 'short' })) : 'No date'}</h3><span class="line"></span></div>
          <div class="list">${list.map(rowHtml).join('')}</div></section>`).join('')
      : `<div class="empty"><h3>${all.length ? 'Nothing here' : 'No expenses yet'}</h3><p>${all.length ? 'Try another filter.' : 'Add what you paid for, snap the receipt, and Tabi works out who owes whom.'}</p>
         ${all.length ? '' : `<button class="btn primary" data-add>${icon('plus')}Add an expense</button>`}</div>`}
    ` : balancesHtml(net)}
  </div>`;

  el.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => openExpense());
  el.querySelector('[data-clear-with]')?.addEventListener('click', () => { withUser = null; render(); });
  el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; render(); });
  el.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => { filter = b.dataset.filter; render(); });
  el.querySelectorAll('[data-open]').forEach((b) => b.onclick = () => openExpense(state.expenses.get(b.dataset.open)));
  el.querySelectorAll('[data-settle]').forEach((b) => b.onclick = () => {
    const other = +b.dataset.settle, v = +b.dataset.amount;
    openPayment(v > 0 ? { from: other, to: me, amount: v } : { from: me, to: other, amount: -v });
  });
  el.querySelectorAll('[data-plan]').forEach((b) => b.onclick = () => {
    const [from, to, amount] = b.dataset.plan.split(':').map(Number);
    openPayment({ from, to, amount });
  });
}

function rowHtml(e) {
  const me = state.me?.id;
  const payer = userById(e.paidBy);
  const mine = e.shares.find((s) => s.userId === me)?.amount || 0;
  let right = '';
  if (e.kind === 'payment') {
    const to = userById(e.shares[0]?.userId);
    right = `<span class="num">${fmt(e.amount, e.currency)}</span>`;
    return `<button class="item money-row" data-open="${e.id}">
      <span class="cat pay">${icon('swap', 'small')}</span>
      <span class="item-main"><div class="item-name">${esc(payer?.name || 'Someone')} paid ${esc(to?.name || 'someone')}</div>
        <div class="item-meta">Payment${e.visibility === 'private' ? ` <span>${icon('lock')}Private</span>` : ''}</div></span>
      <span class="money-right">${right}</span></button>`;
  }
  if (e.paidBy === me) {
    const lent = e.amount - mine;
    right = lent > 0 ? `<span class="pos">you lent</span><b class="num pos">${fmt(lent, e.currency)}</b>` : '<span class="faint">just you</span>';
  } else if (mine) right = `<span class="neg">you owe</span><b class="num neg">${fmt(mine, e.currency)}</b>`;
  else right = '<span class="faint">not involved</span>';
  const cat = CATS[e.category] || CATS.other;
  const grp = e.groupId ? groupById(e.groupId) : null;
  return `<button class="item money-row" data-open="${e.id}">
    <span class="cat" data-cat="${esc(e.category || 'other')}" aria-hidden="true">${cat.glyph}</span>
    <span class="item-main"><div class="item-name">${esc(e.title)}</div>
      <div class="item-meta"><span>${esc(payer?.name || 'Someone')} paid <span class="num">${fmt(e.amount, e.currency)}</span></span>
        ${e.visibility === 'private' ? `<span>${icon('lock')}Private</span>` : ''}
        ${e.attachments?.length ? `<span>${icon('clip')}${e.attachments.length}</span>` : ''}
        ${grp ? `<span class="group-tag" style="--g:${esc(grp.color)}">${esc(grp.name)}</span>` : ''}</div></span>
    <span class="money-right">${right}</span></button>`;
}

function balancesHtml(net) {
  const rows = state.users.map((u) => ({ u, v: net[u.id] || 0 })).sort((a, b) => b.v - a.v);
  const plan = settlePlan(net);
  const anyPrivate = visibleExpenses().some((e) => e.visibility === 'private');
  return `
    <section class="group"><div class="group-head"><h3>Everyone’s balance</h3><span class="line"></span></div>
      <div class="list">${rows.map(({ u, v }) => `<div class="item">${avatar(u)}<div class="item-main"><div class="item-name">${esc(u.name)}</div>
        <div class="item-meta">${v > 0 ? 'is owed' : v < 0 ? 'owes' : 'all square'}</div></div>
        <b class="num ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'faint'}" style="padding-right:8px">${v ? fmt(Math.abs(v)) : '–'}</b></div>`).join('')}</div></section>
    <section class="group"><div class="group-head"><h3>Simplest way to settle up</h3><span class="line"></span></div>
      ${plan.length ? `<div class="list">${plan.map((t) => `<div class="item">${avatar(userById(t.from))}<span class="faint">${icon('arrow-down', 'small')}</span>
        <div class="item-main"><div class="item-name">${esc(userById(t.from)?.name || '?')} pays ${esc(userById(t.to)?.name || '?')}</div><div class="item-meta num">${fmt(t.amount)}</div></div>
        <button class="btn small" data-plan="${t.from}:${t.to}:${t.amount}">Record</button></div>`).join('')}</div>`
      : '<p class="hint" style="margin:0 16px">Nobody owes anything.</p>'}
      ${anyPrivate ? `<p class="hint" style="margin:10px 16px 0">${icon('lock', 'small')} Includes private expenses you’re part of. Other people’s private expenses aren’t shown to you, so their totals may differ.</p>` : ''}
    </section>`;
}

// ---------- settle-up payment ----------
export function openPayment({ from, to, amount }) {
  const c = base();
  const s = openSheet({
    title: 'Record a payment',
    sub: 'Cash, PayPay, Venmo, bank transfer: whatever you used.',
    body: `
      <div class="pay-flow">${avatar(userById(from))}<b>${esc(userById(from)?.name)}</b>${icon('arrow-down')}<b>${esc(userById(to)?.name)}</b>${avatar(userById(to))}</div>
      <label class="field"><span>Amount (${esc(c)})</span><input class="input num amount-input" data-amt inputmode="decimal" value="${toMajor(amount, c)}"></label>
      <label class="check-row" style="padding:6px 0"><input type="checkbox" data-private> Keep private between the two of you</label>`,
    foot: `<button class="btn" data-close>Cancel</button><button class="btn primary" data-save>Record payment</button>`,
  });
  s.el.querySelector('[data-save]').onclick = () => {
    const amt = toMinor(s.el.querySelector('[data-amt]').value, c);
    if (!(amt > 0)) return toast('Enter an amount.');
    op('expense.save', { expense: {
      id: 'e' + uid().slice(1), kind: 'payment', title: 'Payment', amount: amt, currency: c, rate: 1, paidBy: from, date: today(),
      visibility: s.el.querySelector('[data-private]').checked ? 'private' : 'group', splitMode: 'exact', shares: [{ userId: to, amount: amt }],
    } });
    toast('Payment recorded');
    s.close();
  };
}

// ---------- expense editor ----------
function lastCurrency() { return localStorage.getItem('tabi.lastCurrency') || base(); }

export function openExpense(existing) {
  if (existing?.kind === 'payment') return openPaymentView(existing);
  const me = state.me?.id;
  const d = existing ? structuredClone(existing) : {
    id: 'e' + uid().slice(1), kind: 'expense', title: '', amount: 0, currency: lastCurrency(), rate: 1, category: 'food',
    paidBy: me, date: today(), placeId: null, groupId: myGroupOn(today())?.id || null, visibility: 'group', splitMode: 'equal', notes: '',
    shares: [], items: [], attachments: [],
  };
  if (d.currency !== base() && !existing) d.rate = 0;
  let participants = existing ? d.shares.map((s) => s.userId) : (d.groupId ? groupById(d.groupId).memberIds.slice() : state.users.map((u) => u.id));
  const exact = Object.fromEntries((existing?.shares || []).map((s) => [s.userId, s.amount]));
  const weights = Object.fromEntries((existing?.shares || []).map((s) => [s.userId, s.weight ?? 1]));
  let items = (d.items || []).map((i) => ({ ...i }));
  let attachments = (d.attachments || []).map((a) => ({ ...a }));
  let pendingUploads = 0;

  const s = openSheet({
    title: existing ? 'Edit expense' : 'Add an expense',
    className: 'tall',
    body: `
      <div class="amount-row">
        <select class="input currency" data-currency aria-label="Currency">${(state.config.currencies || ['JPY', 'USD']).map((c) => `<option ${c === d.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <input class="input num amount-input" data-amount inputmode="decimal" placeholder="0" value="${d.amount ? toMajor(d.amount, d.currency) : ''}" aria-label="Amount" ${existing ? '' : 'autofocus'}>
      </div>
      <div data-rate-row class="rate-row" hidden>1 <span data-cur></span> = <input class="input num" data-rate inputmode="decimal" style="width:110px;min-height:36px;padding:6px 10px"> ${esc(base())}
        <span class="faint" data-rate-note></span></div>
      <label class="field"><span>What was it?</span><input class="input" data-title value="${esc(d.title)}" placeholder="Dinner at Ichiran, Suica top-up…"></label>
      <div class="chips flush" role="group" aria-label="Category">${Object.entries(CATS).map(([k, c]) => `<button class="chip" data-cat="${k}" aria-pressed="${d.category === k}">${c.label}</button>`).join('')}</div>

      <div class="field"><span>Receipts and screenshots</span>
        <div class="thumbs" data-thumbs></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn small">${icon('camera')}Add photo<input type="file" accept="image/*" multiple data-file hidden></label>
          <button class="btn small" data-scan>${icon('scan')}Read receipt</button>
        </div>
        <div class="help" data-ocr-status></div>
      </div>

      <div class="inline-fields">
        <label class="field"><span>Paid by</span><select class="input" data-paid>${state.users.map((u) => `<option value="${u.id}" ${u.id === d.paidBy ? 'selected' : ''}>${esc(u.name)}${u.id === me ? ' (you)' : ''}</option>`).join('')}</select></label>
        <label class="field"><span>Date</span><input class="input" type="date" data-date value="${esc(d.date || '')}"></label>
      </div>

      <div class="field"><span>Split between</span>
        <div class="chips flush" data-quick></div>
        <div class="who" data-who></div>
      </div>
      <div class="seg" role="group" aria-label="How to split" style="margin-bottom:10px">
        ${[['equal', 'Equally'], ['exact', 'Exact'], ['shares', 'Shares'], ['items', 'By item']].map(([k, l]) => `<button data-mode="${k}" aria-pressed="${d.splitMode === k}">${l}</button>`).join('')}
      </div>
      <div data-split></div>
      <p class="err" data-err hidden></p>

      <label class="row" style="padding:12px 0;gap:12px"><div class="grow"><div class="label">${icon('lock', 'small')} Private</div>
        <div class="help">Only the payer and the people in this split can see it.</div></div>
        <span class="switch"><input type="checkbox" data-private ${d.visibility === 'private' ? 'checked' : ''} aria-label="Private"><span></span></span></label>

      <div class="inline-fields">
        <label class="field"><span>Place (optional)</span><select class="input" data-place><option value="">None</option>
          ${livePlaces().filter((p) => p.status !== 'vetoed').sort((a, b) => (a.day || 'z').localeCompare(b.day || 'z') || a.name.localeCompare(b.name))
            .map((p) => `<option value="${p.id}" ${p.id === d.placeId ? 'selected' : ''}>${esc(p.name)}${p.day ? `, ${esc(fmtDay(p.day, { day: 'numeric', month: 'short' }))}` : ''}</option>`).join('')}</select></label>
        ${state.subgroups.length ? `<label class="field"><span>Subgroup</span><select class="input" data-group><option value="">None</option>
          ${state.subgroups.map((g) => `<option value="${g.id}" ${g.id === d.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      <label class="field"><span>Notes</span><textarea class="input" data-notes rows="2">${esc(d.notes || '')}</textarea></label>
      ${existing ? `<p class="faint" style="font-size:12.5px">Added by ${esc(userById(existing.createdBy)?.name || 'someone')}</p>` : ''}`,
    foot: `${existing ? `<button class="btn danger" data-delete>${icon('trash')}Delete</button>` : '<button class="btn" data-close>Cancel</button>'}<button class="btn primary" data-save>Save</button>`,
  });
  const $ = (sel) => s.el.querySelector(sel);
  const amountMinor = () => toMinor($('[data-amount]').value || 0, d.currency);

  // ----- currency & rate -----
  const loadRate = async () => {
    const row = $('[data-rate-row]');
    row.hidden = d.currency === base();
    $('[data-cur]').textContent = d.currency;
    if (d.currency === base()) { d.rate = 1; return; }
    if (d.rate) { $('[data-rate]').value = d.rate; return; }
    $('[data-rate-note]').textContent = 'looking up…';
    try {
      const r = await api(`/api/rate?from=${d.currency}&to=${base()}`);
      d.rate = r.rate;
      $('[data-rate]').value = r.rate;
      $('[data-rate-note]').textContent = r.date ? `rate from ${r.date}` : '';
    } catch (e) { $('[data-rate-note]').textContent = e.message; }
  };
  $('[data-currency]').onchange = (e) => {
    const amt = $('[data-amount]').value;
    d.currency = e.target.value; d.rate = 0;
    localStorage.setItem('tabi.lastCurrency', d.currency);
    $('[data-amount]').value = amt;
    loadRate(); renderSplit();
  };
  $('[data-rate]').oninput = (e) => { d.rate = +e.target.value; };
  loadRate();

  // ----- category, who, mode -----
  s.el.querySelectorAll('[data-cat]').forEach((b) => b.onclick = () => { d.category = b.dataset.cat; s.el.querySelectorAll('[data-cat]').forEach((x) => x.setAttribute('aria-pressed', x === b)); });
  const renderWho = () => {
    const quick = [['all', 'Everyone', state.users.map((u) => u.id)], ...groupsOn(d.date).map((g) => [g.id, g.name, g.memberIds])];
    $('[data-quick]').innerHTML = quick.map(([k, l, ids]) => `<button class="chip" data-quick-pick="${k}" aria-pressed="${ids.length === participants.length && ids.every((i) => participants.includes(i))}">${esc(l)}</button>`).join('');
    s.el.querySelectorAll('[data-quick-pick]').forEach((b) => b.onclick = () => { participants = quick.find((q) => q[0] === b.dataset.quickPick)[2].slice(); renderWho(); renderSplit(); });
    $('[data-who]').innerHTML = state.users.map((u) => `<button class="who-chip" data-person="${u.id}" aria-pressed="${participants.includes(u.id)}">${avatar(u)}<span>${esc(u.name)}</span></button>`).join('');
    s.el.querySelectorAll('[data-person]').forEach((b) => b.onclick = () => {
      const id = +b.dataset.person;
      participants = participants.includes(id) ? participants.filter((x) => x !== id) : [...participants, id];
      renderWho(); renderSplit();
    });
  };
  s.el.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => {
    d.splitMode = b.dataset.mode;
    s.el.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    if (d.splitMode === 'items' && !items.length) items.push({ name: '', amount: 0, userIds: [] });
    renderSplit();
  });

  // ----- computing shares -----
  function computeShares() {
    const total = amountMinor();
    const ids = participants.slice().sort((a, b) => (a === d.paidBy ? -1 : b === d.paidBy ? 1 : a - b));
    if (!ids.length) return { error: 'Choose at least one person.' };
    if (!(total > 0)) return { error: 'Enter the amount first.' };
    if (d.splitMode === 'equal') {
      const parts = allocate(total, ids.map(() => 1));
      return { shares: ids.map((id, i) => ({ userId: id, amount: parts[i] })) };
    }
    if (d.splitMode === 'exact') {
      const shares = ids.map((id) => ({ userId: id, amount: exact[id] || 0 }));
      const sum = shares.reduce((a, x) => a + x.amount, 0);
      if (sum !== total) return { shares, error: `${fmt(Math.abs(total - sum), d.currency)} ${sum < total ? 'left to assign' : 'too much'}` };
      return { shares };
    }
    if (d.splitMode === 'shares') {
      const w = ids.map((id) => weights[id] ?? 1);
      const parts = allocate(total, w);
      return { shares: ids.map((id, i) => ({ userId: id, amount: parts[i], weight: w[i] })) };
    }
    // By item: each item splits between the people ticked on it (nobody ticked = everyone in the split);
    // tax, service and discounts are spread in proportion to what each person had.
    const sub = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const it of items) {
      const who = it.userIds.filter((u) => ids.includes(u));
      const on = who.length ? who : ids;
      allocate(Math.max(0, it.amount), on.map(() => 1)).forEach((v, i) => { sub[on[i]] += v; });
      if (it.amount < 0) allocate(-it.amount, on.map(() => 1)).forEach((v, i) => { sub[on[i]] -= v; });
    }
    const parts = allocate(total, ids.map((id) => sub[id]));
    return { shares: ids.map((id, i) => ({ userId: id, amount: parts[i] })), itemsSum: items.reduce((a, i) => a + i.amount, 0) };
  }

  function renderSplit() {
    const box = $('[data-split]');
    const ids = participants;
    const c = d.currency;
    const r = computeShares();
    const byId = Object.fromEntries((r.shares || []).map((x) => [x.userId, x.amount]));
    if (d.splitMode === 'items') {
      const extra = amountMinor() - (r.itemsSum || 0);
      box.innerHTML = `
        <div class="items-edit">${items.map((it, i) => `
          <div class="item-edit" data-i="${i}">
            <div class="inline-fields"><input class="input" data-iname value="${esc(it.name)}" placeholder="Item">
              <input class="input num" data-iamt inputmode="decimal" value="${it.amount ? toMajor(it.amount, c) : ''}" placeholder="0" style="flex:0 0 100px">
              <button class="icon-btn" data-idel aria-label="Remove item">${icon('x', 'small')}</button></div>
            <div class="item-who">${ids.map((id) => { const u = userById(id); return `<button class="mini-who" data-iu="${id}" aria-pressed="${it.userIds.includes(id)}" title="${esc(u?.name)}">${esc(u?.name.split(' ')[0] || '?')}</button>`; }).join('')}</div>
          </div>`).join('')}</div>
        <button class="btn small" data-iadd>${icon('plus')}Add item</button>
        <p class="help" style="margin:8px 0 0">Untick everyone on an item to share it with the whole split.
          ${amountMinor() ? `Tax, service and discounts (<span class="num">${fmt(extra, c)}</span>) are shared in proportion.` : ''}</p>
        ${perPerson(ids, byId, c)}`;
      box.querySelectorAll('[data-i]').forEach((row) => {
        const i = +row.dataset.i;
        row.querySelector('[data-iname]').oninput = (e) => { items[i].name = e.target.value; };
        row.querySelector('[data-iamt]').onchange = (e) => { items[i].amount = toMinor(e.target.value || 0, c); renderSplit(); };
        row.querySelector('[data-idel]').onclick = () => { items.splice(i, 1); renderSplit(); };
        row.querySelectorAll('[data-iu]').forEach((b) => b.onclick = () => {
          const u = +b.dataset.iu;
          items[i].userIds = items[i].userIds.includes(u) ? items[i].userIds.filter((x) => x !== u) : [...items[i].userIds, u];
          renderSplit();
        });
      });
      box.querySelector('[data-iadd]').onclick = () => { items.push({ name: '', amount: 0, userIds: [] }); renderSplit(); box.querySelector('.item-edit:last-child [data-iname]')?.focus(); };
    } else if (d.splitMode === 'exact' || d.splitMode === 'shares') {
      box.innerHTML = `<div class="split-rows">${ids.map((id) => { const u = userById(id); return `<label class="split-row">${avatar(u)}<span class="grow">${esc(u?.name)}</span>
        ${d.splitMode === 'exact'
          ? `<input class="input num" data-ex="${id}" inputmode="decimal" value="${exact[id] ? toMajor(exact[id], c) : ''}" placeholder="0" style="width:110px">`
          : `<input class="input num" data-wt="${id}" inputmode="decimal" value="${weights[id] ?? 1}" style="width:70px"><span class="num faint" style="width:90px;text-align:right">${byId[id] != null ? fmt(byId[id], c) : ''}</span>`}</label>`; }).join('')}</div>`;
      box.querySelectorAll('[data-ex]').forEach((inp) => inp.onchange = () => { exact[+inp.dataset.ex] = toMinor(inp.value || 0, c); renderSplit(); });
      box.querySelectorAll('[data-wt]').forEach((inp) => inp.onchange = () => { weights[+inp.dataset.wt] = Math.max(0, +inp.value || 0); renderSplit(); });
    } else {
      box.innerHTML = perPerson(ids, byId, c);
    }
    const err = $('[data-err]');
    err.hidden = !r.error || !amountMinor();
    err.textContent = r.error || '';
  }
  const perPerson = (ids, byId, c) => ids.length && Object.keys(byId).length ? `<div class="per-person">${ids.map((id) => { const u = userById(id); return `<span>${avatar(u)}${esc(u?.name.split(' ')[0])} <b class="num">${fmt(byId[id] || 0, c)}</b></span>`; }).join('')}</div>` : '';

  $('[data-amount]').addEventListener('input', debounce(renderSplit, 250));
  $('[data-date]').onchange = (e) => { d.date = e.target.value || null; renderWho(); };
  $('[data-paid]').onchange = (e) => { d.paidBy = +e.target.value; renderSplit(); };
  renderWho();
  renderSplit();

  // ----- receipts -----
  const renderThumbs = () => {
    $('[data-thumbs]').innerHTML = attachments.map((a, i) => `<span class="thumb">${a.local ? `<img src="${a.local}" alt="">` : `<img src="/api/attachments/${a.id}" alt="" loading="lazy">`}
      ${a.uploading ? '<span class="thumb-busy"></span>' : ''}<button class="thumb-x" data-tx="${i}" aria-label="Remove image">${icon('x', 'small')}</button></span>`).join('');
    s.el.querySelectorAll('[data-tx]').forEach((b) => b.onclick = () => { attachments.splice(+b.dataset.tx, 1); renderThumbs(); });
    s.el.querySelectorAll('.thumb img').forEach((img, i) => img.onclick = () => viewImage(attachments[i]));
  };
  renderThumbs();
  $('[data-file]').onchange = async (e) => {
    for (const file of [...e.target.files].slice(0, 6)) {
      const a = { local: URL.createObjectURL(file), uploading: true, file };
      attachments.push(a);
      renderThumbs();
      pendingUploads++;
      try {
        const { blob, w, h } = await compress(file);
        a.blob = blob;
        const r = await api(`/api/attachments?w=${w}&h=${h}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
        Object.assign(a, { id: r.id, uploading: false });
      } catch (err) {
        attachments.splice(attachments.indexOf(a), 1);
        toast(navigator.onLine ? `Upload failed: ${err.message}` : 'Receipt photos need a connection. Add the expense now and the photo later.');
      } finally { pendingUploads--; renderThumbs(); }
    }
    e.target.value = '';
    if (!d.amount && !$('[data-amount]').value && attachments.length) $('[data-ocr-status]').textContent = 'Tip: tap “Read receipt” to fill in the amount and items.';
  };

  $('[data-scan]').onclick = async () => {
    const a = attachments.find((x) => x.file || x.blob) || attachments[0];
    const status = $('[data-ocr-status]');
    if (!a) { $('[data-file]').click(); status.textContent = 'Add a photo of the receipt first.'; return; }
    const btn = $('[data-scan]');
    btn.disabled = true;
    try {
      const blob = a.blob || a.file || await (await fetch(`/api/attachments/${a.id}`)).blob();
      const { readReceipt } = await import('./ocr.js');
      const { parseReceipt } = await import('./receipt.js');
      const text = await readReceipt(blob, (label, p) => { status.textContent = `${label}… ${Math.round(p * 100)}%`; });
      if (a.id) api(`/api/attachments/${a.id}/ocr`, { method: 'POST', body: { text } }).catch(() => {});
      const r = parseReceipt(text);
      const cur = r.decimals ? (d.currency === base() && base() === 'JPY' ? 'USD' : d.currency) : d.currency;
      if (cur !== d.currency) { d.currency = cur; $('[data-currency]').value = cur; d.rate = 0; loadRate(); }
      if (r.total) $('[data-amount]').value = toMajor(Math.round(r.total * 10 ** digits(d.currency)), d.currency);
      if (r.merchant && !$('[data-title]').value) $('[data-title]').value = r.merchant;
      if (r.date) { $('[data-date]').value = r.date; d.date = r.date; }
      if (r.items.length) {
        items = r.items.map((i) => ({ name: i.name, amount: Math.round(i.amount * 10 ** digits(d.currency)), userIds: [] }));
        d.splitMode = 'items';
        s.el.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.mode === 'items'));
      }
      renderSplit();
      status.textContent = r.total
        ? `Found ${r.items.length} item${r.items.length === 1 ? '' : 's'} and a total of ${fmt(Math.round(r.total * 10 ** digits(d.currency)), d.currency)}. Check them, then tick who had what.`
        : 'Couldn’t find a total. Fill in the amount yourself; any items found are below.';
    } catch (err) {
      console.error(err);
      status.textContent = `Couldn’t read the receipt: ${err.message}`;
    } finally { btn.disabled = false; }
  };

  // ----- save / delete -----
  $('[data-save]').onclick = () => {
    if (pendingUploads) return toast('Wait for the photos to finish uploading.');
    const r = computeShares();
    if (r.error) { const er = $('[data-err]'); er.hidden = false; er.textContent = r.error; er.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
    if (d.currency !== base() && !(d.rate > 0)) return toast(`Enter the ${d.currency} to ${base()} exchange rate.`);
    const title = $('[data-title]').value.trim();
    op('expense.save', { expense: {
      ...d, title: title || CATS[d.category]?.label || 'Expense', amount: amountMinor(), date: $('[data-date]').value || null,
      visibility: $('[data-private]').checked ? 'private' : 'group', notes: $('[data-notes]').value.trim() || null,
      placeId: $('[data-place]').value || null, groupId: s.el.querySelector('[data-group]')?.value || null,
      shares: r.shares, items: d.splitMode === 'items' ? items.filter((i) => i.name || i.amount) : [],
      attachmentIds: attachments.filter((a) => a.id).map((a) => a.id),
      attachments: undefined,
    } });
    toast(existing ? 'Expense saved' : 'Expense added');
    s.close();
  };
  $('[data-delete]')?.addEventListener('click', async () => {
    if (!(await confirmSheet({ title: `Delete ${d.title || 'this expense'}?`, body: 'Balances update for everyone in it.', confirm: 'Delete', danger: true }))) return;
    op('expense.delete', { id: d.id });
    s.close();
  });
}

function openPaymentView(e) {
  const from = userById(e.paidBy), to = userById(e.shares[0]?.userId);
  const s = openSheet({
    title: 'Payment',
    body: `<div class="pay-flow">${avatar(from)}<b>${esc(from?.name)}</b>${icon('arrow-down')}<b>${esc(to?.name)}</b>${avatar(to)}</div>
      <p style="font-size:28px;font-weight:800;text-align:center;margin:8px 0" class="num">${fmt(e.amount, e.currency)}</p>
      <p class="hint" style="text-align:center">${e.date ? esc(fmtDay(e.date)) : ''}${e.visibility === 'private' ? ', private' : ''}</p>`,
    foot: `<button class="btn danger" data-delete>${icon('trash')}Delete payment</button><button class="btn" data-close>Done</button>`,
  });
  s.el.querySelector('[data-delete]').onclick = async () => {
    if (!(await confirmSheet({ title: 'Delete this payment?', body: 'The balances go back to how they were before it.', confirm: 'Delete', danger: true }))) return;
    op('expense.delete', { id: e.id });
    s.close();
  };
}

function viewImage(a) {
  const src = a.local || `/api/attachments/${a.id}`;
  openSheet({ title: 'Receipt', className: 'tall', body: `<img src="${src}" alt="Receipt" style="width:100%;border-radius:12px;display:block">
    <a class="btn small" href="${src}" target="_blank" rel="noopener" style="margin-top:10px">${icon('external')}Open full size</a>` });
}

// Shrink photos before upload: 1600px on the long side, JPEG.
async function compress(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
  return { blob, w, h };
}
