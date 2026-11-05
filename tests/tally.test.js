const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./load');

const L = load('gas/Logic.js');
const mk = (orderId, userId, userName, label, qty, unitPrice, note = '', forWhom = '') =>
  ({ orderId, userId, userName, label, qty, unitPrice, note, forWhom });
const lines = [
  mk('o1', 'U1', '小王', '雙拼便當（油雞＋叉燒）', 1, 160, '飯少'),
  mk('o1', 'U2', '小陳', '雙拼便當（油雞＋叉燒）', 2, 160),
  mk('o1', 'U1', '小王', '滷蛋', 1, 15),
  mk('o1', 'U3', '阿美', '招牌三寶飯', 1, 140, '飯少', '阿華')];

test('isOpen boundary', () => {
  const o = { deadline: '2026-11-04T11:00:00+08:00' };
  assert.equal(L.isOpen(o, Date.parse('2026-11-04T10:59:59+08:00')), true);
  assert.equal(L.isOpen(o, Date.parse('2026-11-04T11:00:00+08:00')), false);
});

test('tallyForStore', () => {
  assert.deepEqual(L.tallyForStore(lines), {
    rows: [{ label: '雙拼便當（油雞＋叉燒）', qty: 3 }, { label: '滷蛋', qty: 1 }, { label: '招牌三寶飯', qty: 1 }],
    notes: [{ text: '飯少', count: 2 }], totalQty: 5, totalAmount: 635 });
});

test('tallyForStore empty', () => {
  assert.deepEqual(L.tallyForStore([]), { rows: [], notes: [], totalQty: 0, totalAmount: 0 });
});

test('tallyByPerson', () => {
  const p = L.tallyByPerson(lines);
  assert.deepEqual(p.map(x => [x.userName, x.amount]), [['小王', 175], ['小陳', 320], ['阿美', 140]]);
  assert.equal(p[2].lines[0].forWhom, '阿華');
  assert.deepEqual(p[0].lines[0], { label: '雙拼便當（油雞＋叉燒）', qty: 1, unitPrice: 160, note: '飯少', forWhom: '' });
});

test('monthlyReport', () => {
  const orders = [
    { orderId: 'o1', storeName: '範例燒臘店', deadline: '2026-11-04T11:00:00+08:00' },
    { orderId: 'o0', storeName: '範例燒臘店', deadline: '2026-10-31T11:00:00+08:00' }];
  const all = lines.concat([mk('o0', 'U1', '小王', '滷蛋', 1, 15)]);
  const r = L.monthlyReport(orders, all, [{ userId: 'U1', name: '王大明', isAdmin: false }], '2026-11');
  assert.deepEqual(r.people[0], { userId: 'U2', name: '小陳', amount: 320 });
  assert.deepEqual(r.people.find(x => x.userId === 'U1'), { userId: 'U1', name: '王大明', amount: 175 });
  assert.deepEqual(r.stores, [{ storeName: '範例燒臘店', count: 1 }]);
});
