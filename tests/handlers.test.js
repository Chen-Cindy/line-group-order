const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load } = require('./load');

const H = load('gas/Logic.js', 'gas/Handlers.js', 'web/memdb.js');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'shaolai-menu.json'), 'utf8'));
const now = Date.parse('2026-11-04T10:00:00+08:00');
const A = { userId: 'UA', name: '行政' }, U = { userId: 'U1', name: '小王' };
const deadline = '2026-11-04T11:00:00+08:00';
const line = { itemId: 'i1', variant: '', choices: [], qty: 1 };

const setup = () => {
  const db = H.MemDb({ members: [{ ...A, isAdmin: true }] });
  const deps = { db, readMenu: () => raw };
  const call = (who, act, p, t = now) => H.handle(act, p || {}, who, deps, t);
  return { db, call };
};
const openOrder = call => {
  const s = call(A, 'saveStore', { name: '範例燒臘店', menu: raw });
  return { store: s, order: call(A, 'createOrder', { storeId: s.storeId, deadline }) };
};

test('new member not admin, name follows LINE', () => {
  const { call } = setup();
  assert.equal(call(U, 'bootstrap').me.isAdmin, false);
  assert.equal(call({ userId: 'U1', name: '王大明' }, 'bootstrap').me.name, '王大明');
  assert.equal(call(A, 'bootstrap').me.isAdmin, true);
});

test('non-admin forbidden', () => {
  const { call } = setup();
  for (const a of ['listStores', 'readMenu', 'saveStore', 'createOrder', 'listOrders', 'setDeadline', 'summary', 'setLinesFor', 'monthly']) {
    assert.throws(() => call(U, a, {}), { code: 'FORBIDDEN' }, a);
  }
});

test('unknown action', () => {
  assert.throws(() => setup().call(A, 'dropTables', {}), { code: 'INVALID' });
});

test('createOrder rejects past or malformed deadline', () => {
  const { call } = setup();
  const s = call(A, 'saveStore', { name: '範例燒臘店', menu: raw });
  assert.throws(() => call(A, 'createOrder', { storeId: s.storeId, deadline: '2026-11-04T09:00:00+08:00' }), { code: 'INVALID' });
  assert.throws(() => call(A, 'createOrder', { storeId: s.storeId, deadline: '2026-11-04 11:00' }), { code: 'INVALID' });
  assert.throws(() => call(A, 'createOrder', { storeId: 'nope', deadline }), { code: 'NOT_FOUND' });
});

test('resubmit replaces, invalid saves nothing', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line, line] });
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] });
  assert.equal(call(U, 'bootstrap', { orderId: order.orderId }).myLines.length, 1);
  assert.throws(() => call(U, 'saveMyLines', { orderId: order.orderId, lines: [line, { ...line, itemId: 'zz' }] }), { code: 'INVALID' });
  assert.equal(call(U, 'bootstrap', { orderId: order.orderId }).myLines.length, 1);
  const b = call(U, 'bootstrap', { orderId: order.orderId });
  assert.equal(b.order.open, true);
  assert.equal(b.order.storeName, '範例燒臘店');
  assert.equal(b.myLines[0].userName, '小王');
});

test('menu snapshot not affected by later store edit', () => {
  const { call } = setup();
  const { store, order } = openOrder(call);
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] });
  call(A, 'saveStore', { storeId: store.storeId, name: '範例燒臘店', menu: { categories: [{ name: 'a', items: [
    { id: 'i1', name: '招牌三寶飯', variants: [{ label: '', price: 999 }] }] }] } });
  assert.equal(call(A, 'summary', { orderId: order.orderId }).store.totalAmount, 140);
  assert.equal(call(A, 'listStores')[0].menu.categories[0].items[0].variants[0].price, 999);
});

test('deadline: member closed, admin still edits', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] });
  const late = Date.parse(deadline);
  assert.throws(() => call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] }, late), { code: 'CLOSED' });
  call(A, 'setLinesFor', { orderId: order.orderId, userId: 'U1', lines: [line, line] }, late);
  const s = call(A, 'summary', { orderId: order.orderId }, late);
  assert.deepEqual([s.people[0].userName, s.people[0].amount], ['小王', 280]);
  assert.equal(s.order.open, false);
  assert.ok(s.order.menu.categories.length > 0);
  assert.equal(s.lines.length, 2);
});

test('setDeadline closes early; listOrders and monthly', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line, line] });
  call(A, 'setDeadline', { orderId: order.orderId, deadline: '2026-11-04T09:30:00+08:00' });
  assert.equal(call(U, 'bootstrap', { orderId: order.orderId }).order.open, false);
  const list = call(A, 'listOrders');
  assert.deepEqual([list[0].orderId, list[0].peopleCount, list[0].open], [order.orderId, 1, false]);
  assert.equal(call(A, 'monthly', { month: '2026-11' }).people[0].amount, 280);
});

test('listOrders newest deadline first', () => {
  const { call } = setup();
  const s = call(A, 'saveStore', { name: '範例燒臘店', menu: raw });
  const o1 = call(A, 'createOrder', { storeId: s.storeId, deadline });
  const o2 = call(A, 'createOrder', { storeId: s.storeId, deadline: '2026-11-05T11:00:00+08:00' });
  assert.deepEqual(call(A, 'listOrders').map(o => o.orderId), [o2.orderId, o1.orderId]);
});

test('unknown order', () => {
  assert.throws(() => setup().call(U, 'bootstrap', { orderId: 'nope' }), { code: 'NOT_FOUND' });
});

test('readMenu keeps unsure, limits images', () => {
  const { call } = setup();
  const img = { mimeType: 'image/jpeg', data: 'x' };
  assert.equal(call(A, 'readMenu', { images: [img] }).menu.categories[3].items[1].unsure, true);
  assert.throws(() => call(A, 'readMenu', { images: [] }), { code: 'INVALID' });
  assert.throws(() => call(A, 'readMenu', { images: [img, img, img, img, img] }), { code: 'INVALID' });
});

test('saveStore clears unsure', () => {
  const { call } = setup();
  assert.equal(call(A, 'saveStore', { name: 'x', menu: raw }).menu.categories[3].items[1].unsure, false);
  assert.throws(() => call(A, 'saveStore', { name: '  ', menu: raw }), { code: 'INVALID' });
});

test('MemDb dump round-trip', () => {
  const { db, call } = setup();
  call(A, 'saveStore', { name: 'x', menu: raw });
  assert.equal(H.MemDb(db.dump()).listStores().length, 1);
});

test('summary lists members so admin can add for someone with no lines', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  call(U, 'bootstrap');
  const s = call(A, 'summary', { orderId: order.orderId });
  assert.deepEqual(s.members.map(m => m.userId).sort(), ['U1', 'UA']);
  call(A, 'setLinesFor', { orderId: order.orderId, userId: 'U1', lines: [line] }, Date.parse(deadline));
  assert.equal(call(A, 'summary', { orderId: order.orderId }).people[0].userName, '小王');
});

test('readMenu returns a summary so the admin can spot missing sections', () => {
  const { db } = setup();
  const withInfo = Object.assign(JSON.parse(JSON.stringify(raw)), { _ai: { model: 'gemini-3.8-flash', finishReason: 'MAX_TOKENS' } });
  const r = H.handle('readMenu', { images: [{ mimeType: 'image/jpeg', data: 'x' }] }, A, { db, readMenu: () => withInfo }, now);
  assert.match(r.note, /gemini-3\.8-flash/);
  assert.match(r.note, /4 個分類、7 項/);
  assert.match(r.note, /截斷/);
  const plain = H.handle('readMenu', { images: [{ mimeType: 'image/jpeg', data: 'x' }] }, A, { db, readMenu: () => raw }, now);
  assert.equal(plain.note, '讀到 4 個分類、7 項');
});

// ---- 暫停供應 ----
test('setSoldOut is admin-only', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  assert.throws(() => call(U, 'setSoldOut', { orderId: order.orderId, soldOut: { items: ['i1'] } }), { code: 'FORBIDDEN' });
});

test('paused item/option: member cannot order it, admin still can, others unaffected', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  const duck = { itemId: 'i5', variant: '', choices: [['油雞', '叉燒']], qty: 1 };
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] });
  call(A, 'setSoldOut', { orderId: order.orderId, soldOut: { items: ['i1'], choices: ['選兩種肉/叉燒'] } });
  assert.deepEqual(call(U, 'bootstrap', { orderId: order.orderId }).order.soldOut, { items: ['i1'], choices: ['選兩種肉/叉燒'] });
  assert.throws(() => call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] }), e => e.code === 'INVALID' && /暫停/.test(e.message));
  assert.throws(() => call(U, 'saveMyLines', { orderId: order.orderId, lines: [duck] }), e => /叉燒/.test(e.message));
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [{ ...duck, choices: [['油雞', '烤鴨']] }] });
  call(A, 'setLinesFor', { orderId: order.orderId, userId: 'U1', lines: [line] });
});

test('summary lists people who already ordered something now paused', () => {
  const { call } = setup();
  const { order } = openOrder(call);
  call(U, 'saveMyLines', { orderId: order.orderId, lines: [line] });
  call({ userId: 'U2', name: '小陳' }, 'saveMyLines', { orderId: order.orderId, lines: [{ itemId: 'i6', variant: '', choices: [], qty: 1 }] });
  call(A, 'setSoldOut', { orderId: order.orderId, soldOut: { items: ['i1'] } });
  const s = call(A, 'summary', { orderId: order.orderId });
  assert.deepEqual(s.affected.map(a => [a.userName, a.labels]), [['小王', ['招牌三寶飯']]]);
  assert.deepEqual(s.order.soldOut, { items: ['i1'], choices: [] });
});

test('createOrder can start with paused items', () => {
  const { call } = setup();
  const s = call(A, 'saveStore', { name: '範例燒臘店', menu: raw });
  const o = call(A, 'createOrder', { storeId: s.storeId, deadline, soldOut: { items: ['i2'] } });
  assert.deepEqual(call(U, 'bootstrap', { orderId: o.orderId }).order.soldOut, { items: ['i2'], choices: [] });
  const plain = call(A, 'createOrder', { storeId: s.storeId, deadline });
  assert.deepEqual(call(U, 'bootstrap', { orderId: plain.orderId }).order.soldOut, { items: [], choices: [] });
});
