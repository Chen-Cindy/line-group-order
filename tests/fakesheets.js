// 最小的 Apps Script 假環境（SpreadsheetApp、LockService、Utilities、CacheService、UrlFetchApp），
// 只模擬 SheetDb.js / Main.js 用到的部分，讓試算表資料層也能在 node 裡測。
const crypto = require('crypto');

function makeSheet(name, maxRows) {
  const data = [];
  let max = maxRows;
  const set = (r, c, v) => {
    while (data.length < r) data.push([]);
    const row = data[r - 1];
    while (row.length < c) row.push('');
    row[c - 1] = typeof v === 'string' && v[0] === "'" ? v.slice(1) : v; // 開頭單引號＝強制文字
  };
  const get = (r, c) => {
    const v = (data[r - 1] || [])[c - 1];
    return v === undefined ? '' : v;
  };
  const sh = {
    getName: () => name,
    getLastRow: () => {
      for (let i = data.length - 1; i >= 0; i--) if ((data[i] || []).some(v => v !== '')) return i + 1;
      return 0;
    },
    getMaxRows: () => max,
    insertRowsAfter: (after, n) => { max += n; },
    deleteRow: r => { data.splice(r - 1, 1); max -= 1; },
    setFrozenRows: () => {},
    clearRow: r => { data[r - 1] = []; }, // 測試用：模擬擁有者手動清掉一列
    getRange: (r, c, nr = 1, nc = 1) => {
      if (r < 1 || r + nr - 1 > max) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      const rng = {
        getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => get(r + i, c + j))),
        getValue: () => get(r, c),
        setValues: vals => { vals.forEach((row, i) => row.forEach((v, j) => set(r + i, c + j, v))); return rng; },
        setValue: v => { set(r, c, v); return rng; },
        setNumberFormat: () => rng,
        setFontWeight: () => rng,
        insertCheckboxes: () => rng
      };
      return rng;
    }
  };
  return sh;
}

function installFakeGas({ maxRows = 1000, verify } = {}) {
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n, maxRows)),
    getSheets: () => Object.values(sheets),
    deleteSheet: sh => { delete sheets[sh.getName()]; }
  };
  const cache = {};
  const props = { LINE_CHANNEL_ID: '123' };
  Object.assign(globalThis, {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      sleep: () => {},
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s).digest()].map(b => (b > 127 ? b - 256 : b))
    },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const r = verify ? verify(url, opts) : { code: 400, body: '{}' };
        return { getResponseCode: () => r.code, getContentText: () => r.body };
      }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ setMimeType: () => ({ text: s }) })
    }
  });
  return { ss, sheets, props };
}

module.exports = { installFakeGas };
