// Exchange rates for the converter and the expense form. The whole ECB table is fetched at once
// (it's small) and kept on the device, so conversions keep working offline.
import { api } from './store.js';

const LS = { rates: 'tabi.fx.rates', own: 'tabi.fx.own', home: 'tabi.fx.to', from: 'tabi.fx.from' };
const FRESH_MS = 6 * 3600e3;

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private mode */ } };

export const savedTable = () => read(LS.rates, null);

// Returns { base, date, rates, fetchedAt, offline? } or null if there's nothing at all.
export async function getTable({ force = false } = {}) {
  const saved = savedTable();
  if (!force && saved && Date.now() - (saved.savedAt || 0) < FRESH_MS) return saved;
  try {
    const t = await api('/api/rates');
    const out = { ...t, savedAt: Date.now() };
    write(LS.rates, out);
    return out;
  } catch {
    return saved ? { ...saved, offline: true } : null;
  }
}

// Market rate: how many `to` for one `from`, or null if the table doesn't have one of them.
export function marketRate(table, from, to) {
  if (from === to) return 1;
  const a = table?.rates?.[from], b = table?.rates?.[to];
  return a && b ? b / a : null;
}

// Your own rate for a pair (what your card or the exchange counter actually gives you).
export const ownRates = () => read(LS.own, {});
export function setOwnRate(from, to, rate) {
  const all = ownRates();
  if (rate > 0) all[`${from}>${to}`] = rate; else delete all[`${from}>${to}`];
  write(LS.own, all);
}
export const ownRate = (from, to) => ownRates()[`${from}>${to}`] || null;

const REGION = {
  US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', KR: 'KRW', TW: 'TWD', HK: 'HKD', SG: 'SGD', CN: 'CNY', TH: 'THB',
  PH: 'PHP', MX: 'MXN', CH: 'CHF', IN: 'INR', MY: 'MYR', VN: 'VND', ID: 'IDR', JP: 'JPY',
  DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', IE: 'EUR', PT: 'EUR', FI: 'EUR', GR: 'EUR', LU: 'EUR',
};
export function homeCurrency(tripCurrency, available) {
  const saved = localStorage.getItem(LS.home);
  if (saved && available.includes(saved)) return saved;
  let region = '';
  try { region = new Intl.Locale(navigator.language).maximize().region || ''; } catch { /* old browser */ }
  const guess = REGION[region];
  return guess && guess !== tripCurrency && available.includes(guess) ? guess : tripCurrency === 'USD' ? 'EUR' : 'USD';
}
export const rememberHome = (c) => localStorage.setItem(LS.home, c);
export const rememberFrom = (c) => localStorage.setItem(LS.from, c);
export const savedFrom = () => localStorage.getItem(LS.from);

// Round amounts that make sense for a currency: ¥100, ¥500, ¥1,000… or $1, $5, $10…
export function niceAmounts(table, currency) {
  const perEur = table?.rates?.[currency] || (currency === 'JPY' ? 160 : 1);
  const nice = (x) => {
    const p = 10 ** Math.floor(Math.log10(x));
    const m = x / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  };
  return [...new Set([0.6, 3, 6, 12, 30, 60, 120, 300].map((eur) => nice(eur * perEur)))];
}

// Amounts may be typed as sums ("1200+850", "3 x 480"). Returns a number or NaN.
export function parseAmount(text) {
  const s = String(text || '').replace(/[,\s¥$€£₩]/g, '').replace(/[x×]/gi, '*').replace(/÷/g, '/');
  if (!s) return NaN;
  if (!/^[\d.+\-*/()]+$/.test(s)) return NaN;
  let i = 0;
  const peek = () => s[i];
  function num() {
    if (peek() === '(') { i++; const v = sum(); if (s[i++] !== ')') throw 0; return v; }
    if (peek() === '-') { i++; return -num(); }
    const m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
    if (!m) throw 0;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function prod() { let v = num(); while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = num(); v = op === '*' ? v * r : v / r; } return v; }
  function sum() { let v = prod(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = prod(); v = op === '+' ? v + r : v - r; } return v; }
  try { const v = sum(); return i === s.length && Number.isFinite(v) ? v : NaN; } catch { return NaN; }
}
