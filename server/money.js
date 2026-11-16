// Validation for expenses and settle-up payments.
export const CURRENCIES = {
  JPY: 0, USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, NZD: 2, KRW: 0, TWD: 2, HKD: 2,
  SGD: 2, CNY: 2, THB: 2, PHP: 2, MXN: 2, CHF: 2, INR: 2, MYR: 2, VND: 0, IDR: 0,
};
export const CATEGORIES = ['food', 'transport', 'lodging', 'activities', 'shopping', 'other'];

const err = (m) => Object.assign(new Error(m), { expose: true });
const int = (v) => (Number.isInteger(+v) ? +v : NaN);

export function cleanExpense(d, { userIds, now = Date.now() }) {
  if (!/^[\w-]{6,64}$/.test(String(d.id || ''))) throw err('Bad expense id');
  const kind = d.kind === 'payment' ? 'payment' : 'expense';
  const currency = String(d.currency || '').toUpperCase();
  if (!(currency in CURRENCIES)) throw err('Unsupported currency');
  const amount = int(d.amount);
  if (!(amount > 0) || amount > 1e12) throw err('Enter an amount greater than zero.');
  const rate = +d.rate;
  if (!(rate > 0) || !Number.isFinite(rate)) throw err('Exchange rate must be a positive number.');
  const paidBy = +d.paidBy;
  if (!userIds.has(paidBy)) throw err('Choose who paid.');
  const shares = (Array.isArray(d.shares) ? d.shares : []).map((s) => ({ userId: +s.userId, amount: int(s.amount), weight: s.weight == null ? null : +s.weight }));
  if (!shares.length) throw err('Choose who this is split between.');
  const seen = new Set();
  for (const s of shares) {
    if (!userIds.has(s.userId)) throw err('Someone in the split is no longer in the trip.');
    if (seen.has(s.userId)) throw err('Someone is in the split twice.');
    if (!Number.isInteger(s.amount)) throw err('Split amounts must be whole numbers.');
    seen.add(s.userId);
  }
  const sum = shares.reduce((a, s) => a + s.amount, 0);
  if (sum !== amount) throw err(`The split adds up to ${sum}, not ${amount}.`);
  if (kind === 'payment' && (shares.length !== 1 || shares[0].userId === paidBy)) throw err('A payment goes from one person to another.');

  const items = (Array.isArray(d.items) ? d.items : []).slice(0, 300).map((it) => ({
    name: String(it.name || '').slice(0, 120) || 'Item',
    amount: int(it.amount),
    userIds: (Array.isArray(it.userIds) ? it.userIds : []).map(Number).filter((u) => userIds.has(u)),
  })).filter((it) => Number.isInteger(it.amount));

  const date = d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null;
  return {
    id: d.id, kind, currency, amount, rate, paidBy, shares, items, date,
    title: String(d.title || '').trim().slice(0, 120) || (kind === 'payment' ? 'Payment' : 'Expense'),
    category: CATEGORIES.includes(d.category) ? d.category : (kind === 'payment' ? null : 'other'),
    placeId: d.placeId ? String(d.placeId).slice(0, 64) : null,
    groupId: d.groupId ? String(d.groupId).slice(0, 64) : null,
    visibility: d.visibility === 'private' ? 'private' : 'group',
    splitMode: ['equal', 'exact', 'shares', 'items'].includes(d.splitMode) ? d.splitMode : 'equal',
    notes: d.notes ? String(d.notes).slice(0, 2000) : null,
    attachmentIds: (Array.isArray(d.attachmentIds) ? d.attachmentIds : []).map(String).filter((x) => /^[\w-]{6,64}$/.test(x)).slice(0, 20),
  };
}
