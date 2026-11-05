// 一次性安裝：在 Apps Script 編輯器選 setupSheets 按「執行」，同意授權後看執行記錄有沒有 SELFTEST PASS。

var DEFAULT_LINE_CHANNEL_ID_ = 'YOUR_LINE_LOGIN_CHANNEL_ID'; // 佔位：請在指令碼屬性填 LINE_CHANNEL_ID（安裝說明第四段）

function setupSheets() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('LINE_CHANNEL_ID')) props.setProperty('LINE_CHANNEL_ID', DEFAULT_LINE_CHANNEL_ID_);
  ensureSheets_(SpreadsheetApp.getActiveSpreadsheet());
  return selfTest_();
}

// Claude 整理好的菜單直接寫進菜單庫：node tools/build-import.js 店名… 產生 gas/ImportMenus.js，
// clasp push 後在編輯器選 importMenus 按「執行」。同名的店更新菜單、沒有的新增；任一份有問題整批不寫。
function importMenus() {
  var list = typeof IMPORT_MENUS_ === 'undefined' ? [] : IMPORT_MENUS_;
  check_(list.length, '沒有要匯入的菜單');
  var ready = list.map(function (raw) {
    var name = str_(raw && raw.name);
    check_(name, '有一份菜單沒有店名');
    var menu = normalizeMenu(raw, { clearUnsure: true });
    menuCell_(menu); // 太大會在這裡擋下，免得寫到一半
    return { name: name, menu: menu };
  });
  var db = SheetDb(), now = taipeiIso(Date.now());
  var done = db.withLock(function () {
    var ids = {};
    db.listStores().forEach(function (s) { ids[s.name] = s.storeId; });
    return ready.map(function (m) {
      db.saveStore({ storeId: ids[m.name] || '', name: m.name, menu: m.menu, updatedAt: now });
      return (ids[m.name] ? '更新 ' : '新增 ') + m.name;
    });
  });
  Logger.log(done.join('\n'));
  return done;
}

// 冪等：只補缺少的分頁與表頭
function ensureSheets_(ss) {
  Object.keys(SCHEMA_).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SCHEMA_[name];
    if (sh.getRange(1, 1).getValue() === '') {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      // 舊表升級：尾端新加的欄位補上表頭（資料讀寫不靠表頭，這只是給人看的）
      var cur = sh.getRange(1, 1, 1, headers.length).getValues()[0];
      headers.forEach(function (h, i) { if (cur[i] === '') sh.getRange(1, i + 1).setValue(h).setFontWeight('bold'); });
    }
  });
  var blank = ss.getSheets().filter(function (sh) {
    return !SCHEMA_[sh.getName()] && sh.getLastRow() === 0;
  });
  blank.forEach(function (sh) { ss.deleteSheet(sh); }); // 移除建立時的空白「工作表1」
}

function check_(ok, what) {
  if (!ok) throw new Error(what);
}

// 在真的試算表上跑一輪讀寫，結束時一定清掉測試資料
function selfTest_() {
  var db = SheetDb(), uid = 'TEST_' + Date.now(), made = { store: '', order: '' };
  var now = taipeiIso(Date.now());
  try {
    var me = db.upsertMember({ userId: uid, name: '+測試' });
    check_(me.isAdmin === false, '新成員不該是行政');
    check_(db.listMembers().some(function (m) { return m.userId === uid && m.name === '+測試'; }), '成員讀回');

    var menu = normalizeMenu({ categories: [{ name: 'a', items: [{ name: '測試飯', variants: [{ label: '', price: 100 }] }] }] });
    var s = db.saveStore({ storeId: '', name: '測試店', menu: menu, updatedAt: now });
    made.store = s.storeId;
    check_(db.getStore(s.storeId).menu.categories[0].items[0].name === '測試飯', '店家讀回');

    var o = db.createOrder({ storeId: s.storeId, storeName: s.name, menu: s.menu,
      deadline: '2099-01-01T11:00:00+08:00', createdBy: uid, createdAt: now });
    made.order = o.orderId;
    check_(db.getOrder(o.orderId).deadline === '2099-01-01T11:00:00+08:00', '截止時間被試算表轉型了');
    db.updateOrder(o.orderId, { deadline: '2099-01-02T11:00:00+08:00' });
    check_(db.getOrder(o.orderId).deadline === '2099-01-02T11:00:00+08:00', '更新截止時間');

    var line = resolveLine(o.menu, { itemId: 'i1', variant: '', choices: [], qty: 2, note: '=1+1' });
    line.orderId = o.orderId; line.userId = uid; line.userName = '+測試'; line.updatedAt = now;
    db.replaceLines(o.orderId, uid, [line, line]);
    db.replaceLines(o.orderId, uid, [line]);
    var back = db.getLines(o.orderId);
    check_(back.length === 1, '重送應取代舊明細，實際 ' + back.length + ' 筆');
    check_(back[0].qty === 2 && back[0].unitPrice === 100, '數量或單價讀回不對');
    check_(back[0].note === '=1+1', '公式字元沒有原樣存回：' + back[0].note);
    db.replaceLines(o.orderId, uid, []);
    check_(db.getLines(o.orderId).length === 0, '清空明細');

    Logger.log('SELFTEST PASS');
    return 'PASS';
  } catch (err) {
    Logger.log('SELFTEST FAIL: ' + err.message);
    return 'FAIL: ' + err.message;
  } finally {
    deleteRows_('明細', function (r) { return String(r[1]) === uid; });
    deleteRows_('訂單', function (r) { return String(r[0]) === made.order; });
    deleteRows_('店家', function (r) { return String(r[0]) === made.store; });
    deleteRows_('成員', function (r) { return String(r[0]) === uid; });
  }
}
