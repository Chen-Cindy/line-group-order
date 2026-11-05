// SheetDb.js / Main.js 在假 Apps Script 環境裡的測試（真正的試算表另由 setupSheets 的 selfTest 驗）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakeGas } = require('./fakesheets');
const { load } = require('./load');

let verifyReply = { code: 200, body: JSON.stringify({ sub: 'U1', name: '小王', exp: Math.floor(Date.now() / 1000) + 3600 }) };
const fake = installFakeGas({ maxRows: 30, verify: () => verifyReply });
const G = load('gas/Logic.js', 'gas/Handlers.js', 'gas/SheetDb.js', 'gas/Setup.js', 'gas/Main.js');
G.ensureSheets_(fake.ss);

const menu = G.normalizeMenu({ categories: [{ name: 'a', items: [{ name: '飯', variants: [{ label: '', price: 100 }] }] }] });
const order = () => G.SheetDb().createOrder({ storeId: 's', storeName: '店', menu, deadline: '2099-01-01T11:00:00+08:00', createdBy: 'UA', createdAt: 'x' });
const lineFor = (o, uid) => Object.assign(G.resolveLine(o.menu, { itemId: 'i1', variant: '', choices: [], qty: 1 }),
  { orderId: o.orderId, userId: uid, userName: uid, updatedAt: 'x' });

test('replaceLines keeps working past the sheet row limit', () => {
  const db = G.SheetDb(), o = order();
  for (let i = 0; i < 40; i++) db.replaceLines(o.orderId, 'U' + (i % 5), [lineFor(o, 'U' + (i % 5)), lineFor(o, 'U' + (i % 5))]);
  assert.equal(db.getLines(o.orderId).length, 10);
});

test('rows cleared by hand are skipped, not crashing lists', () => {
  const db = G.SheetDb();
  db.saveStore({ storeId: '', name: '甲', menu, updatedAt: 'x' });
  db.saveStore({ storeId: '', name: '乙', menu, updatedAt: 'x' });
  fake.sheets['店家'].clearRow(2);
  assert.deepEqual(db.listStores().map(s => s.name), ['乙']);
  const o = order();
  fake.sheets['訂單'].clearRow(2);
  assert.ok(db.listOrders().every(x => x.orderId));
  assert.equal(db.getOrder(o.orderId).orderId, o.orderId);
});

test('huge menu is rejected with a clear INVALID, normal menu round-trips compactly', () => {
  const db = G.SheetDb();
  const items = Array.from({ length: 400 }, (_, i) => ({ name: '飲料' + i, variants: [{ label: '中', price: 50 }, { label: '大', price: 60 }],
    groups: [{ name: '甜度', min: 1, max: 1, choices: ['正常', '少糖', '半糖', '微糖', '無糖'].map(l => ({ label: l })) },
      { name: '冰塊', min: 1, max: 1, choices: ['正常', '少冰', '微冰', '去冰', '熱'].map(l => ({ label: l })) }] }));
  const big = G.normalizeMenu({ categories: [{ name: '飲料', items }] });
  assert.throws(() => db.saveStore({ storeId: '', name: '大店', menu: big, updatedAt: 'x' }), { code: 'INVALID' });
  const s = db.saveStore({ storeId: '', name: '小店', menu, updatedAt: 'x' });
  assert.deepEqual(db.getStore(s.storeId).menu, menu);
});

test('verify: 400 is UNAUTHORIZED, LINE outage is not', () => {
  verifyReply = { code: 400, body: '{"error":"invalid_request"}' };
  assert.throws(() => G.verifyIdToken_('tok-a'), { code: 'UNAUTHORIZED' });
  verifyReply = { code: 503, body: 'down' };
  assert.throws(() => G.verifyIdToken_('tok-b'), err => err.code !== 'UNAUTHORIZED');
  verifyReply = { code: 200, body: JSON.stringify({ sub: 'U9', name: '阿九', exp: Math.floor(Date.now() / 1000) + 3600 }) };
  assert.deepEqual(G.verifyIdToken_('tok-c'), { userId: 'U9', name: '阿九' });
});

test('setupSheets fills LINE_CHANNEL_ID when missing, keeps an existing one', () => {
  delete fake.props.LINE_CHANNEL_ID;
  assert.equal(G.setupSheets(), 'PASS');
  assert.equal(fake.props.LINE_CHANNEL_ID, 'YOUR_LINE_LOGIN_CHANNEL_ID');
  fake.props.LINE_CHANNEL_ID = '999';
  G.setupSheets();
  assert.equal(fake.props.LINE_CHANNEL_ID, '999');
});

test('importMenus updates a store with the same name, adds new ones, and writes nothing if any menu is bad', () => {
  const db = G.SheetDb();
  const old = db.saveStore({ storeId: '', name: '匯入甲', menu, updatedAt: 'x' });
  const raw = (name, items) => ({ name, categories: [{ name: '便當', items }] });
  globalThis.IMPORT_MENUS_ = [raw('匯入甲', [{ name: '排骨飯', price: 120 }]), raw('匯入乙', [{ name: '雞腿飯', price: 130 }])];
  assert.deepEqual(G.importMenus(), ['更新 匯入甲', '新增 匯入乙']);
  const byName = n => db.listStores().filter(s => s.name === n);
  assert.equal(byName('匯入甲').length, 1);
  assert.equal(byName('匯入甲')[0].storeId, old.storeId);
  assert.equal(byName('匯入甲')[0].menu.categories[0].items[0].name, '排骨飯');
  assert.equal(byName('匯入乙')[0].menu.categories[0].items[0].variants[0].price, 130);

  globalThis.IMPORT_MENUS_ = [raw('匯入丙', [{ name: '飯', price: 1 }]), raw('匯入丁', [{ name: '麵', price: 1 }, { name: '麵', price: 2 }])];
  assert.throws(() => G.importMenus(), /出現兩次/);
  assert.equal(byName('匯入丙').length, 0);
  delete globalThis.IMPORT_MENUS_;
  assert.throws(() => G.importMenus(), /沒有要匯入的菜單/);
});

test('Gemini failure tells the admin the HTTP status and reason', () => {
  fake.props.GEMINI_API_KEY = 'k';
  const saved = verifyReply;
  verifyReply = { code: 429, body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }) };
  assert.throws(() => G.readMenuWithGemini_([{ mimeType: 'image/jpeg', data: 'x' }]),
    err => err.code === 'AI_FAILED' && /429/.test(err.message) && /RESOURCE_EXHAUSTED/.test(err.message));
  verifyReply = { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"categories":[' }] }, finishReason: 'MAX_TOKENS' }] }) };
  assert.throws(() => G.readMenuWithGemini_([{ mimeType: 'image/jpeg', data: 'x' }]),
    err => err.code === 'AI_FAILED' && /MAX_TOKENS/.test(err.message));
  verifyReply = saved;
});

// 依序回傳 replies 裡的 {code, body}，記下每次打的模型
function geminiSeq(replies, fn) {
  fake.props.GEMINI_API_KEY = 'k';
  delete fake.props.GEMINI_MODEL;
  const models = [], orig = UrlFetchApp.fetch;
  geminiSeq.payloads = [];
  UrlFetchApp.fetch = (url, opts) => {
    models.push(url.match(/models\/([^:]+):/)[1]);
    geminiSeq.payloads.push(JSON.parse(opts.payload));
    if (geminiSeq.slowMs) clock += geminiSeq.slowMs;
    const r = replies[Math.min(models.length - 1, replies.length - 1)];
    return { getResponseCode: () => r.code, getContentText: () => r.body };
  };
  try { return fn(models); } finally { UrlFetchApp.fetch = orig; geminiSeq.slowMs = 0; }
}
// 假時鐘：模擬一次呼叫花了很久
let clock = Date.now();
const realNow = Date.now;
Date.now = () => clock;
const err = (code, status) => ({ code, body: JSON.stringify({ error: { code, status } }) });
const okMenu = { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"categories":[{"name":"a","items":[{"name":"飯","variants":[{"label":"","price":100}]}]}]}' }] } }] }) };
const img = [{ mimeType: 'image/jpeg', data: 'x' }];

test('Gemini: defaults to gemini-flash-latest', () => geminiSeq([okMenu], models => {
  assert.equal(G.readMenuWithGemini_(img).categories[0].name, 'a');
  assert.deepEqual(models, ['gemini-flash-latest']);
}));

test('Gemini: 503 retries the same model, then falls back to Flash-Lite', () => {
  geminiSeq([err(503, 'UNAVAILABLE'), okMenu], models => {
    G.readMenuWithGemini_(img);
    assert.deepEqual(models, ['gemini-flash-latest', 'gemini-flash-latest']);
  });
  geminiSeq([err(503, 'UNAVAILABLE'), err(503, 'UNAVAILABLE'), okMenu], models => {
    G.readMenuWithGemini_(img);
    assert.deepEqual(models, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-lite-latest']);
  });
});

test('Gemini: gives up after three busy replies and says so', () => geminiSeq([err(503, 'UNAVAILABLE')], models => {
  assert.throws(() => G.readMenuWithGemini_(img), e => e.code === 'AI_FAILED' && /503 UNAVAILABLE/.test(e.message));
  assert.equal(models.length, 3);
}));

test('Gemini: 404 skips straight to Flash-Lite and names the model', () => geminiSeq([err(404, 'NOT_FOUND')], models => {
  assert.throws(() => G.readMenuWithGemini_(img), e => /NOT_FOUND/.test(e.message) && /gemini-flash-lite-latest/.test(e.message));
  assert.deepEqual(models, ['gemini-flash-latest', 'gemini-flash-lite-latest']);
}));

test('Gemini: bad key (400) is not retried', () => geminiSeq([err(400, 'INVALID_ARGUMENT')], models => {
  assert.throws(() => G.readMenuWithGemini_(img), e => /400 INVALID_ARGUMENT/.test(e.message));
  assert.equal(models.length, 1);
}));

test('Gemini: asks for low thinking (menu transcription does not need deep reasoning)', () => geminiSeq([okMenu], () => {
  G.readMenuWithGemini_(img);
  assert.equal(geminiSeq.payloads[0].generationConfig.thinkingConfig.thinkingLevel, 'low');
}));

test('Gemini: a slow busy reply is not retried (keeps total wait bounded)', () => {
  geminiSeq.slowMs = 70000;
  geminiSeq([err(503, 'UNAVAILABLE')], models => {
    assert.throws(() => G.readMenuWithGemini_(img), e => e.code === 'AI_FAILED');
    assert.equal(models.length, 1);
  });
});

test('Gemini: success carries model version and finish reason for the summary', () => geminiSeq([{ code: 200, body: JSON.stringify({
  modelVersion: 'gemini-3.8-flash', usageMetadata: { candidatesTokenCount: 1234 },
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"categories":[{"name":"a","items":[{"name":"飯","variants":[{"label":"","price":100}]}]}]}' }] } }] }) }], () => {
  const raw = G.readMenuWithGemini_(img);
  assert.deepEqual(raw._ai, { model: 'gemini-3.8-flash', finishReason: 'STOP', outputTokens: 1234 });
}));

test('Gemini prompt explains "-" sizes, shared options and completeness', () => geminiSeq([okMenu], () => {
  G.readMenuWithGemini_(img);
  const prompt = geminiSeq.payloads[0].contents[0].parts[0].text;
  for (const must of ['「-」', '糖量', '冰量', '最外層', '一個都不能漏']) assert.ok(prompt.includes(must), must);
}));

test('SheetDb: soldOut round-trips; rows written before the column existed read as empty', () => {
  const db = G.SheetDb(), o = order();
  assert.deepEqual(db.getOrder(o.orderId).soldOut, { items: [], choices: [] });
  db.updateOrder(o.orderId, { soldOut: { items: ['i1'], choices: ['加料/波霸'] } });
  assert.deepEqual(db.getOrder(o.orderId).soldOut, { items: ['i1'], choices: ['加料/波霸'] });
  const o2 = db.createOrder({ storeId: 's', storeName: '店', menu, deadline: '2099-01-01T11:00:00+08:00', createdBy: 'UA', createdAt: 'x', soldOut: { items: ['i1'], choices: [] } });
  assert.deepEqual(db.getOrder(o2.orderId).soldOut, { items: ['i1'], choices: [] });
});
