// Turns OCR text from a receipt (Japanese or English) into a merchant, date, total and line items.
// Amounts are returned in major units (yen, or dollars with cents as decimals).

const TOTAL = /(合\s*計|総\s*計|お会計|ご請求|請求額|お買上|total|amount\s*due|grand\s*total|balance\s*due)/i;
const SUBTOTAL = /(小\s*計|sub\s*-?\s*total)/i;
const TAX = /(消費税|内税|外税|税\s*額|税\s*\d+\s*%|\d+\s*%\s*対象|対象\s*額|tax|vat|gst)/i;
const SKIP = /(お\s*預|預\s*り|お\s*釣|釣\s*銭|おつり|現\s*金|クレジット|カード|電子マネー|paypay|suica|pasmo|icoca|交通系|change|cash|tendered|visa|master|amex|jcb|paid|支\s*払|点\s*数|買上点数|領収|レシート|no\.|tel|電話|登録番号|〒|担当|レジ|伝票|receipt|invoice|qty|数量|単価|ポイント|point)/i;
const DISCOUNT = /(値引|割引|クーポン|discount|coupon|off\b)/i;
const SERVICE = /(サービス料|service\s*charge|サ\s*料|tip|gratuity|チャージ)/i;

// A price at the end of a line: ¥1,280 / 1,280円 / 1280 / 12.50 / -300 / ¥1,280※ / 1,280外 / 1,280 軽
const PRICE_AT_END = /(-|−|▲|△)?\s*[¥\\$]?\s*(\d{1,3}(?:[,，.]\d{3})+|\d+)(?:[.．](\d{2}))?\s*(円|-|ー|\*|※|＊|内|外|軽|税|[A-Z]{1,2})?\s*$/;

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[￥]/g, '¥')
    .replace(/[‐‑‒–—―ー](?=\d)/g, '-')
    .replace(/[ \t]+/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function priceOf(line, decimals) {
  const m = line.match(PRICE_AT_END);
  if (!m) return null;
  // The number must stand on its own: "1-2-3" (an address) or "11/12/2026" (a date) aren't prices
  const start = m.index + (m[0].length - m[0].trimStart().length);
  const before = line[start - 1];
  if (start > 0 && /[\d\-/.:]/.test(before) && !/[¥\\$]/.test(m[0])) return null;
  let intPart = m[2];
  let frac = m[3];
  // "12.50" style when the receipt uses decimals and the thousands-group regex grabbed ".50"
  if (!frac && decimals && /^\d+\.\d{2}$/.test(intPart)) { [intPart, frac] = intPart.split('.'); }
  const n = parseInt(intPart.replace(/[,，.]/g, ''), 10);
  if (!Number.isFinite(n)) return null;
  let value = frac ? n + parseInt(frac, 10) / 100 : n;
  if (m[1]) value = -value;
  const name = line.slice(0, m.index).replace(/[¥\\$@×*※・:：\s]+$/, '').trim();
  return { value, name, raw: m[0] };
}

function findDate(lines) {
  for (const l of lines) {
    let m = l.match(/(20\d{2})\s*[年/.\-]\s*(\d{1,2})\s*[月/.\-]\s*(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = l.match(/\b(R|令和)\s*(\d{1,2})\s*[年/.]\s*(\d{1,2})\s*[月/.]\s*(\d{1,2})/); // Reiwa era: R6 = 2024
    if (m) return `${2018 + +m[2]}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`;
    m = l.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/); // US style m/d/yyyy
    if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  return null;
}

export function parseReceipt(text) {
  const lines = normalize(text);
  const decimals = lines.filter((l) => /\d+\.\d{2}\s*$/.test(l)).length >= 2 && !lines.some((l) => /円|¥/.test(l));
  const out = { merchant: null, date: findDate(lines), total: null, subtotal: null, tax: 0, service: 0, items: [], decimals, lines };

  // Merchant: first line with real letters, skipping obvious headers
  out.merchant = lines.find((l) => /[\p{L}]{2,}/u.test(l) && !/(領収|レシート|receipt|invoice|welcome|いらっしゃいませ|ありがとう|tel|〒|\d{2,}-\d{2,})/i.test(l) && l.length <= 40) || null;

  const totals = [];
  let reachedTotal = false;
  for (const line of lines) {
    const p = priceOf(line, decimals);
    if (!p) continue;
    const label = p.name || line;
    if (TOTAL.test(label) && !SUBTOTAL.test(label)) { totals.push(Math.abs(p.value)); reachedTotal = true; continue; }
    if (SUBTOTAL.test(label)) { out.subtotal = Math.abs(p.value); continue; }
    if (TAX.test(label)) { if (/外税|tax|vat|gst|消費税/i.test(label) && !/内/.test(label)) out.tax += Math.abs(p.value); continue; }
    if (SKIP.test(label)) continue;
    if (reachedTotal) continue; // anything after the total is payment details
    if (SERVICE.test(label)) { out.service += Math.abs(p.value); continue; }
    if (!p.name || p.name.length < 1 || /^\d+$/.test(p.name)) continue;
    if (/^\d{1,2}:\d{2}/.test(p.name) || /\d{4}[年/.-]\d{1,2}/.test(p.name)) continue; // times and dates
    const value = DISCOUNT.test(label) ? -Math.abs(p.value) : p.value;
    if (Math.abs(value) > 10_000_000) continue;
    // "2コ X ¥119" or "@300 x 2" are unit-price lines for the item above, which already has its total
    if (/^(\d+\s*(コ|個|点|本|枚|pcs?)?\s*[x×*]|@|単)/i.test(p.name)) continue;
    if (/[都道府県].*[区市町村]|丁目|番地/.test(p.name)) continue; // address
    out.items.push({ name: p.name.replace(/\s{2,}/g, ' ').slice(0, 60), amount: value });
  }
  out.total = totals.length ? Math.max(...totals) : null;
  const itemsSum = out.items.reduce((a, i) => a + i.amount, 0);
  if (out.total == null) out.total = out.subtotal != null ? out.subtotal + out.tax + out.service : (itemsSum > 0 ? itemsSum + out.tax + out.service : null);
  if (out.service) out.items.push({ name: 'Service charge', amount: out.service });
  return out;
}
