const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load } = require('./load');

const L = load('gas/Logic.js');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'shaolai-menu.json'), 'utf8'));
const m = L.normalizeMenu(raw);

test('ids & cleanup', () => {
  const items = m.categories.flatMap(c => c.items);
  assert.deepEqual(items.map(i => i.id), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7']);
  assert.equal(m.categories.length, 4); // 空分類、空白品名都被丟掉
  assert.equal(items[1].variants[0].price, 170);
  assert.equal(items[3].variants[0].price, 1000);
  assert.equal(items[6].unsure, true);
  assert.equal(items[0].unsure, false);
  assert.equal(items[6].variants[1].price, 0); // 時價 → 0 且 unsure
  assert.equal(items[4].groups[0].choices[2].delta, 10);
  assert.equal(items[4].groups[0].choices[0].delta, 0);
});

test('normalizeMenu does not mutate input', () => {
  assert.equal(raw.categories[0].items[1].variants[0].price, '$170');
});

test('existing ids kept, duplicates reassigned', () => {
  const m2 = L.normalizeMenu({ categories: [{ name: 'a', items: [
    { id: 'x', name: 'A', variants: [{ label: '', price: 1 }] },
    { id: 'x', name: 'B', variants: [{ label: '', price: 1 }] }] }] });
  assert.deepEqual(m2.categories[0].items.map(i => i.id), ['x', 'i1']);
});

test('clearUnsure', () => {
  assert.equal(L.normalizeMenu(raw, { clearUnsure: true }).categories[3].items[1].unsure, false);
});

test('empty menu throws INVALID', () => {
  assert.throws(() => L.normalizeMenu({ categories: [] }), { code: 'INVALID' });
  assert.throws(() => L.normalizeMenu(null), { code: 'INVALID' });
});

test('group min/max clamped', () => {
  const g = L.normalizeMenu({ categories: [{ name: 'a', items: [{ name: 'X', variants: [{ label: '', price: 1 }],
    groups: [{ name: 'g', min: 3, max: 9, choices: [{ label: 'p' }, { label: 'q' }] }] }] }] }).categories[0].items[0].groups[0];
  assert.deepEqual([g.min, g.max], [2, 2]);
});

test('toAmount', () => {
  assert.equal(L.toAmount(140), 140);
  assert.equal(L.toAmount('$170'), 170);
  assert.equal(L.toAmount('1,000'), 1000);
  assert.equal(L.toAmount(' 50 '), 50);
  assert.equal(L.toAmount('時價'), null);
  assert.equal(L.toAmount(''), null);
});

test('resolveLine', () => {
  assert.deepEqual(L.resolveLine(m, { itemId: 'i1', variant: '', choices: [], qty: 1 }),
    { itemId: 'i1', variant: '', choices: [], qty: 1, note: '', forWhom: '', unitPrice: 140, label: '招牌三寶飯' });
  assert.equal(L.resolveLine(m, { itemId: 'i3', variant: '條', choices: [], qty: 2 }).label, '港燒蜜腸 條');
  const a = L.resolveLine(m, { itemId: 'i5', variant: '', choices: [['叉燒', '油雞']], qty: 1 });
  const b = L.resolveLine(m, { itemId: 'i5', variant: '', choices: [['油雞', '叉燒']], qty: 1 });
  assert.equal(a.label, '雙拼便當（油雞＋叉燒）');
  assert.equal(b.label, a.label);
  assert.deepEqual(a.choices, [['油雞', '叉燒']]);
  assert.equal(a.unitPrice, 160);
  assert.equal(L.resolveLine(m, { itemId: 'i1', variant: '', choices: [], qty: 1, note: ' 飯少 '.padEnd(200, 'x') }).note.length, 100);
});

test('resolveLine rejects', () => {
  for (const bad of [
    { itemId: 'nope', variant: '', choices: [], qty: 1 },
    { itemId: 'i3', variant: '半', choices: [], qty: 1 },
    { itemId: 'i5', variant: '', choices: [['叉燒']], qty: 1 },
    { itemId: 'i5', variant: '', choices: [['叉燒', '叉燒']], qty: 1 },
    { itemId: 'i5', variant: '', choices: [['叉燒', '雞腿']], qty: 1 },
    { itemId: 'i1', variant: '', choices: [], qty: 0 },
    { itemId: 'i1', variant: '', choices: [], qty: 51 },
    { itemId: 'i1', variant: '', choices: [], qty: 1.5 },
  ]) assert.throws(() => L.resolveLine(m, bad), { code: 'INVALID' }, JSON.stringify(bad));
});

test('variants text round-trip', () => {
  assert.deepEqual(L.parseVariants('140'), [{ label: '', price: 140 }]);
  assert.deepEqual(L.parseVariants('份 50 / 條 $130'), [{ label: '份', price: 50 }, { label: '條', price: 130 }]);
  assert.equal(L.formatVariants([{ label: '份', price: 50 }, { label: '條', price: 130 }]), '份 50 / 條 130');
  assert.equal(L.formatVariants([{ label: '', price: 140 }]), '140');
  const duck = [{ label: '全', price: 1000 }, { label: '半', price: 500 }, { label: '1/4', price: 280 }];
  assert.deepEqual(L.parseVariants(L.formatVariants(duck)), duck); // 「1/4」不能被當成分隔
  assert.deepEqual(L.parseVariants('份50/條130'), [{ label: '份', price: 50 }, { label: '條', price: 130 }]);
  assert.throws(() => L.parseVariants('份 / 條'), { code: 'INVALID' });
  assert.throws(() => L.parseVariants(''), { code: 'INVALID' });
});

test('groups text round-trip', () => {
  const g = L.parseGroups('選兩種肉 2: 烤鴨、油雞、叉燒+10\n甜度 1-1: 正常,半糖，無糖');
  assert.deepEqual(g[0], { name: '選兩種肉', min: 2, max: 2, choices: [
    { label: '烤鴨', delta: 0 }, { label: '油雞', delta: 0 }, { label: '叉燒', delta: 10 }] });
  assert.deepEqual([g[1].min, g[1].max, g[1].choices.length], [1, 1, 3]);
  assert.equal(L.formatGroups(g), '選兩種肉 2: 烤鴨、油雞、叉燒+10\n甜度 1: 正常、半糖、無糖');
  assert.deepEqual(L.parseGroups('  '), []);
  assert.throws(() => L.parseGroups('沒有冒號'), { code: 'INVALID' });
});

// ---- 審查後補強 ----
test('normalizeMenu tolerates wrong shapes from AI', () => {
  const m3 = L.normalizeMenu({ categories: [
    { name: 'a', items: [
      { name: '單價物件', variants: { label: '', price: 170 } },
      { name: '物件群組', variants: [{ label: '', price: 1 }], groups: { name: 'g', min: 1, max: 1, choices: [{ label: 'p' }] } },
      { name: '字串選項', variants: [{ label: '', price: 1 }], groups: [{ name: '甜度', min: 1, max: 1, choices: '正常,半糖' }] },
      { name: '蔬菜', price: '時價' },
      { name: '白飯', price: 15 },
      { name: '加價壞掉', variants: [{ label: '', price: 1 }], groups: [{ name: 'g', min: 1, max: 1, choices: [{ label: 'p', delta: '+10' }, { label: 'q', delta: '看情況' }] }] }] },
    { name: 'b', items: { name: '分類物件', variants: [{ label: '', price: 2 }] } }] });
  const items = m3.categories.flatMap(c => c.items);
  const by = n => items.find(i => i.name === n);
  assert.equal(by('單價物件').variants[0].price, 170);
  assert.equal(by('物件群組').groups[0].choices[0].label, 'p');
  assert.deepEqual(by('字串選項').groups[0].choices.map(c => c.label), ['正常', '半糖']);
  assert.deepEqual([by('蔬菜').variants, by('蔬菜').unsure], [[{ label: '', price: 0 }], true]);
  assert.deepEqual([by('白飯').variants, by('白飯').unsure], [[{ label: '', price: 15 }], false]);
  assert.equal(by('加價壞掉').groups[0].choices[0].delta, 10);
  assert.equal(by('加價壞掉').unsure, true);
  assert.equal(by('分類物件').variants[0].price, 2);
});

test('duplicates: flagged on read, rejected on save', () => {
  const dup = { categories: [
    { name: '便當', items: [{ name: '叉燒', variants: [{ label: '', price: 100 }] }] },
    { name: '單點', items: [{ name: '叉燒', variants: [{ label: '', price: 60 }] },
      { name: '蔬菜', variants: [{ label: '', price: 120 }, { label: '', price: 80 }] },
      { name: '雙拼', variants: [{ label: '', price: 150 }], groups: [{ name: 'g', min: 2, max: 2, choices: [{ label: '油雞' }, { label: '油雞' }, { label: '叉燒' }] }] }] }] };
  const read = L.normalizeMenu(dup);
  const items = read.categories.flatMap(c => c.items);
  assert.deepEqual(items.map(i => i.unsure), [true, true, true, false]);
  assert.deepEqual(items[3].groups[0].choices.map(c => c.label), ['油雞', '叉燒']);
  assert.throws(() => L.normalizeMenu(dup, { clearUnsure: true }), { code: 'INVALID', message: /叉燒/ });
});

test('compactMenu drops defaults and round-trips', () => {
  const c = L.compactMenu(m);
  assert.ok(JSON.stringify(c).length < JSON.stringify(m).length);
  assert.equal(JSON.stringify(c).includes('"unsure":false'), false);
  assert.deepEqual(L.normalizeMenu(c), m);
});

test('Logic.js has no regex lookbehind (iOS < 16.4 cannot parse it)', () => {
  assert.equal(/\(\?<[=!]/.test(fs.readFileSync(path.join(__dirname, '..', 'gas', 'Logic.js'), 'utf8')), false);
});

// ---- 實測範例飲料店菜單後補強 ----
test('sizes marked "-" are not sold: dropped when another size has a price', () => {
  const mm = L.normalizeMenu({ categories: [{ name: '飲中甜品', items: [
    { name: '開心果可可', variants: [{ label: 'M', price: 85 }, { label: 'L', price: '-' }, { label: '瓶', price: '－' }] },
    { name: '楊枝甘露', variants: [{ label: 'M', price: 0 }, { label: 'L', price: 90 }, { label: '瓶', price: null }] },
    { name: '蔬菜', variants: [{ label: '大', price: 50 }, { label: '小', price: '時價' }] },
    { name: '只有槓', variants: [{ label: 'M', price: '-' }] }] }] }, { fromAi: true });
  const [cocoa, mango, veg, dash] = mm.categories[0].items;
  assert.deepEqual([cocoa.variants, cocoa.unsure], [[{ label: 'M', price: 85 }], false]);
  assert.deepEqual([mango.variants, mango.unsure], [[{ label: 'L', price: 90 }], false]);
  assert.deepEqual([veg.variants.length, veg.unsure], [2, true]); // 時價 是有賣只是沒標價，保留並標黃
  assert.deepEqual([dash.variants, dash.unsure], [[{ label: 'M', price: 0 }], true]);
  // 存過的菜單重讀時不動 0 元份量
  const stored = L.normalizeMenu({ categories: [{ name: 'a', items: [{ name: 'x', variants: [{ label: '大', price: 50 }, { label: '小', price: 0 }] }] }] });
  assert.equal(stored.categories[0].items[0].variants.length, 2);
});

test('shared option groups (menu-level and category-level) are copied into every item', () => {
  const sweet = { name: '甜度', min: 1, max: 1, choices: [{ label: '正常' }, { label: '半糖' }, { label: '無糖' }] };
  const ice = { name: '冰塊', min: 1, max: 1, choices: [{ label: '正常冰' }, { label: '去冰' }] };
  const top = { name: '加料', min: 0, max: 2, choices: [{ label: '波霸', delta: 10 }, { label: '芝芝', delta: 20 }] };
  const mm = L.normalizeMenu({ groups: [sweet, ice], categories: [
    { name: '果粒茶', groups: [top], items: [{ name: '香橙果粒茶', variants: [{ label: 'L', price: 75 }] }] },
    { name: '原味茶', items: [{ name: '高山金萱茶', variants: [{ label: 'L', price: 30 }],
      groups: [{ name: '甜度', min: 1, max: 1, choices: [{ label: '固定' }] }] }] }] });
  assert.deepEqual(mm.categories[0].items[0].groups.map(g => g.name), ['加料', '甜度', '冰塊']);
  assert.deepEqual(mm.categories[1].items[0].groups.map(g => g.name), ['甜度', '冰塊']);
  assert.deepEqual(mm.categories[1].items[0].groups[0].choices.map(c => c.label), ['固定']); // 品項自己的優先
  const line = L.resolveLine(mm, { itemId: 'i1', variant: 'L', choices: [['波霸', '芝芝'], ['半糖'], ['去冰']], qty: 1 });
  assert.equal(line.unitPrice, 105);
  assert.equal(line.label, '香橙果粒茶 L（波霸＋芝芝；半糖；去冰）');
});

// ---- 貼上 Claude 整理好的菜單 ----
test('parseMenuPaste: takes JSON out of a chat reply (code fence, text around it)', () => {
  const body = { name: '範例飲料店', groups: [{ name: '甜度', min: 1, max: 1, choices: [{ label: '正常' }, { label: '半糖' }] }],
    categories: [{ name: '飲中甜品', items: [{ name: '開心果椰水', variants: [{ label: 'M', price: 85 }, { label: 'L', price: '-' }] }] }] };
  const pasted = '整理好了：\n```json\n' + JSON.stringify(body, null, 2) + '\n```\n貼到行政頁就可以。';
  const r = L.parseMenuPaste(pasted);
  assert.equal(r.name, '範例飲料店');
  const item = r.menu.categories[0].items[0];
  assert.deepEqual(item.variants, [{ label: 'M', price: 85 }]);
  assert.deepEqual(item.groups.map(g => g.name), ['甜度']);
});

test('parseMenuPaste: anything that is not a whole menu is rejected clearly', () => {
  for (const bad of ['', '你好', '{"categories":[', '{"categories":[]}']) {
    assert.throws(() => L.parseMenuPaste(bad), { code: 'INVALID' }, bad);
  }
});

// ---- 暫停供應 ----
test('normalizeSoldOut cleans up and dedupes', () => {
  assert.deepEqual(L.normalizeSoldOut(null), { items: [], choices: [] });
  assert.deepEqual(L.normalizeSoldOut({ items: ['i1', 'i1', '', 3], choices: ['加料/波霸', ' 加料/波霸 '] }),
    { items: ['i1', '3'], choices: ['加料/波霸'] });
});

test('soldOutReason flags paused items and paused options', () => {
  const so = { items: ['i1'], choices: ['選兩種肉/叉燒'] };
  assert.match(L.soldOutReason(m, so, { itemId: 'i1', variant: '', choices: [] }), /招牌三寶飯.*暫停/);
  assert.match(L.soldOutReason(m, so, { itemId: 'i5', variant: '', choices: [['油雞', '叉燒']] }), /叉燒.*暫停/);
  assert.equal(L.soldOutReason(m, so, { itemId: 'i5', variant: '', choices: [['油雞', '烤鴨']] }), '');
  assert.equal(L.soldOutReason(m, { items: [], choices: [] }, { itemId: 'i1', variant: '', choices: [] }), '');
});
