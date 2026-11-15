import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt } from '../public/js/receipt.js';

test('konbini receipt with discount and internal tax', () => {
  const r = parseReceipt(`ファミリーマート 渋谷店
東京都渋谷区道玄坂1-2-3
2026年11月15日(日) 14:32
おにぎり 鮭        ¥160※
ﾍﾟｯﾄﾎﾞﾄﾙ お茶      ¥140※
からあげクン         ¥238※
2コ X ¥119
値引                -¥30
小計               ¥508
内消費税等          ¥37
合計               ¥508
お預り             ¥1,000
お釣               ¥492`);
  assert.equal(r.merchant, 'ファミリーマート 渋谷店');
  assert.equal(r.date, '2026-11-15');
  assert.equal(r.total, 508);
  assert.deepEqual(r.items.map((i) => i.amount), [160, 140, 238, -30]);
});

test('izakaya with service charge and external tax', () => {
  const r = parseReceipt(`居酒屋 とり吉
2026/11/16 20:15
生ビール 3 1,650
焼き鳥盛り合わせ 1,280
枝豆 480
小計 3,410
サービス料 10% 341
外税 10% 375
合計 ¥4,126
クレジット VISA 4,126`);
  assert.equal(r.total, 4126);
  assert.equal(r.tax, 375);
  assert.deepEqual(r.items.map((i) => i.name), ['生ビール 3', '焼き鳥盛り合わせ', '枝豆', 'Service charge']);
});

test('US receipt with decimals', () => {
  const r = parseReceipt(`JOE'S DINER
11/12/2026
Burger 14.50
Fries 4.25
Subtotal 18.75
Tax 1.66
Total 20.41
VISA 20.41`);
  assert.equal(r.decimals, true);
  assert.equal(r.total, 20.41);
  assert.equal(r.date, '2026-11-12');
  assert.deepEqual(r.items.map((i) => i.amount), [14.5, 4.25]);
});
