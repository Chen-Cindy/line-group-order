// 試算表資料層：方法與 web/memdb.js 相同。表頭是給擁有者看的，欄位順序不能改。

var SCHEMA_ = {
  '成員': ['userId', '暱稱', '行政', '首次使用', '最近使用'],
  '店家': ['storeId', '店名', '菜單JSON', '更新時間'],
  '訂單': ['orderId', 'storeId', '店名', '菜單JSON', '截止時間', '建立者', '建立時間', '暫停JSON'], // 新欄位只加在尾端
  '明細': ['orderId', 'userId', '暱稱', 'itemId', '份量', '選項JSON', '數量', '單價', '品項', '備註', '幫誰點', '更新時間']
};
var NON_TEXT_COLS_ = { '行政': true, '數量': true, '單價': true };

function newId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

// 使用者輸入（暱稱、備註）開頭是 = + - @ 時加單引號，避免被試算表當成公式
function cell_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { ensureSheets_(ss); sh = ss.getSheetByName(name); }
  return sh;
}

function readRows_(name) {
  var sh = sheet_(name), n = sh.getLastRow();
  return n < 2 ? [] : sh.getRange(2, 1, n - 1, SCHEMA_[name].length).getValues();
}

function appendRows_(name, rows) {
  if (!rows.length) return;
  var sh = sheet_(name), start = sh.getLastRow() + 1;
  // getRange 不會自己長出列，deleteRow 又會讓表越刪越短：不夠就先補，多留 200 列
  var over = start + rows.length - 1 - sh.getMaxRows();
  if (over > 0) sh.insertRowsAfter(sh.getMaxRows(), over + 200);
  SCHEMA_[name].forEach(function (h, i) {
    if (!NON_TEXT_COLS_[h]) sh.getRange(start, i + 1, rows.length, 1).setNumberFormat('@');
  });
  sh.getRange(start, 1, rows.length, SCHEMA_[name].length)
    .setValues(rows.map(function (r) { return r.map(cell_); }));
}

// 從表尾往上刪，列號才不會跑掉
function deleteRows_(name, pred) {
  var sh = sheet_(name), rows = readRows_(name);
  for (var i = rows.length - 1; i >= 0; i--) {
    if (pred(rows[i])) sh.deleteRow(i + 2);
  }
}

// 只改指定欄位（逐格寫，不整列覆寫）；row 是 1 起算的資料列號（不含表頭）
function setCells_(name, rowIndex, patch) {
  var sh = sheet_(name), headers = SCHEMA_[name];
  Object.keys(patch).forEach(function (h) {
    sh.getRange(rowIndex + 1, headers.indexOf(h) + 1).setValue(cell_(patch[h]));
  });
}

function indexOfKey_(rows, key) {
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) === key) return i;
  return -1;
}

// 擁有者可能在試算表手動清掉某列：第一欄空白的列一律跳過
function hasKey_(r) {
  return String(r[0]) !== '';
}

var MAX_CELL_CHARS_ = 49000; // 試算表單格上限 50,000 字

function menuCell_(menu) {
  var s = JSON.stringify(compactMenu(menu));
  if (s.length > MAX_CELL_CHARS_) throw appError('INVALID', '菜單太大，超過試算表的上限，請刪掉一些品項或拆成兩家店');
  return s;
}

function toStore_(r) {
  return { storeId: String(r[0]), name: String(r[1]), menu: normalizeMenu(JSON.parse(r[2])), updatedAt: String(r[3]) };
}

function toOrder_(r) {
  return {
    orderId: String(r[0]), storeId: String(r[1]), storeName: String(r[2]), menu: normalizeMenu(JSON.parse(r[3])),
    deadline: String(r[4]), createdBy: String(r[5]), createdAt: String(r[6]),
    soldOut: normalizeSoldOut(r[7] ? JSON.parse(r[7]) : null) // 舊的列沒有這欄＝沒有暫停
  };
}

function toLine_(r) {
  return {
    orderId: String(r[0]), userId: String(r[1]), userName: String(r[2]), itemId: String(r[3]),
    variant: String(r[4]), choices: JSON.parse(r[5] || '[]'), qty: Number(r[6]), unitPrice: Number(r[7]),
    label: String(r[8]), note: String(r[9]), forWhom: String(r[10]), updatedAt: String(r[11])
  };
}

function SheetDb() {
  var db = {
    upsertMember: function (m) {
      var today = taipeiIso(Date.now()).slice(0, 10);
      var rows = readRows_('成員'), i = indexOfKey_(rows, m.userId);
      if (i < 0) {
        return db.withLock(function () {
          rows = readRows_('成員');
          i = indexOfKey_(rows, m.userId);
          if (i < 0) {
            appendRows_('成員', [[m.userId, m.name, false, today, today]]);
            sheet_('成員').getRange(rows.length + 2, 3).insertCheckboxes();
            return { userId: m.userId, name: m.name, isAdmin: false };
          }
          return { userId: m.userId, name: String(rows[i][1]), isAdmin: rows[i][2] === true };
        });
      }
      // 名字變了才改名；最近使用一天只寫一次，避免每個請求都寫表
      var patch = {};
      if (String(rows[i][1]) !== m.name) patch['暱稱'] = m.name;
      if (String(rows[i][4]) !== today) patch['最近使用'] = today;
      if (Object.keys(patch).length) setCells_('成員', i + 1, patch);
      return { userId: m.userId, name: m.name, isAdmin: rows[i][2] === true };
    },
    listMembers: function () {
      return readRows_('成員').filter(hasKey_).map(function (r) {
        return { userId: String(r[0]), name: String(r[1]), isAdmin: r[2] === true };
      });
    },

    listStores: function () { return readRows_('店家').filter(hasKey_).map(toStore_); },
    getStore: function (storeId) {
      var rows = readRows_('店家'), i = indexOfKey_(rows, storeId);
      return i < 0 ? null : toStore_(rows[i]);
    },
    saveStore: function (s) {
      var rows = readRows_('店家'), i = s.storeId ? indexOfKey_(rows, s.storeId) : -1;
      if (i >= 0) {
        setCells_('店家', i + 1, { '店名': s.name, '菜單JSON': menuCell_(s.menu), '更新時間': s.updatedAt });
        return s;
      }
      var out = { storeId: newId_(), name: s.name, menu: s.menu, updatedAt: s.updatedAt };
      appendRows_('店家', [[out.storeId, out.name, menuCell_(out.menu), out.updatedAt]]);
      return out;
    },

    createOrder: function (o) {
      var out = JSON.parse(JSON.stringify(o));
      out.orderId = newId_();
      out.soldOut = normalizeSoldOut(out.soldOut);
      appendRows_('訂單', [[out.orderId, out.storeId, out.storeName, menuCell_(out.menu),
        out.deadline, out.createdBy, out.createdAt, JSON.stringify(out.soldOut)]]);
      return out;
    },
    getOrder: function (orderId) {
      var rows = readRows_('訂單'), i = indexOfKey_(rows, orderId);
      return i < 0 ? null : toOrder_(rows[i]);
    },
    // ponytail: 每張單都解析菜單 JSON，幾百張內沒問題；變慢再拆出不含菜單的清單讀法
    listOrders: function () { return readRows_('訂單').filter(hasKey_).map(toOrder_); },
    updateOrder: function (orderId, patch) {
      var rows = readRows_('訂單'), i = indexOfKey_(rows, orderId);
      if (i < 0) return null;
      if (patch.deadline) setCells_('訂單', i + 1, { '截止時間': patch.deadline });
      if (patch.soldOut) setCells_('訂單', i + 1, { '暫停JSON': JSON.stringify(normalizeSoldOut(patch.soldOut)) });
      return db.getOrder(orderId);
    },

    getLines: function (orderId) {
      return readRows_('明細').filter(function (r) { return String(r[0]) === orderId; }).map(toLine_);
    },
    // ponytail: 整表讀取，一年約 1 萬列內沒問題；變慢再改成依月份索引
    listAllLines: function () { return readRows_('明細').filter(hasKey_).map(toLine_); },
    replaceLines: function (orderId, userId, lines) {
      deleteRows_('明細', function (r) { return String(r[0]) === orderId && String(r[1]) === userId; });
      appendRows_('明細', lines.map(function (l) {
        return [l.orderId, l.userId, l.userName, l.itemId, l.variant, JSON.stringify(l.choices),
          l.qty, l.unitPrice, l.label, l.note, l.forWhom, l.updatedAt];
      }));
    },

    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try { return fn(); } finally { lock.releaseLock(); }
    }
  };
  return db;
}
