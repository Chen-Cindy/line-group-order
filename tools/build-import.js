// 把 menus/ 裡指定的菜單包成 gas/ImportMenus.js，給 Setup.js 的 importMenus 寫進菜單庫。
// 用法：node tools/build-import.js 店名1 店名2 …（對應 menus/店名.json），接著 clasp push。
const fs = require('fs');
const path = require('path');
require('../tests/load').load('gas/Logic.js');

const root = path.join(__dirname, '..');
const names = process.argv.slice(2).map(n => n.replace(/^menus[\\/]/, '').replace(/\.json$/, ''));
if (!names.length) {
  console.error('用法：node tools/build-import.js 店名 …');
  process.exit(1);
}
const list = names.map(n => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'menus', n + '.json'), 'utf8'));
  normalizeMenu(raw, { clearUnsure: true }); // 重複品名等問題在這裡就擋下
  return raw;
});
fs.writeFileSync(path.join(root, 'gas', 'ImportMenus.js'),
  '// 由 tools/build-import.js 產生，別手改。在 Apps Script 編輯器執行 importMenus 寫進菜單庫。\n' +
  'var IMPORT_MENUS_ = ' + JSON.stringify(list) + ';\n');
console.log('gas/ImportMenus.js：' + list.map(m => m.name).join('、'));
