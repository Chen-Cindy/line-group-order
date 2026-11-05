// 把 gas/*.js、web/memdb.js 這類「頂層只有 function/var」的共用檔載進目前的全域，給 node:test 用。
// 用 runInThisContext（同一個 realm），assert.deepStrictEqual 比對陣列/物件才不會因原型不同而失敗。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load(...relPaths) {
  for (const rel of relPaths) {
    vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'), { filename: rel });
  }
  return globalThis;
}

module.exports = { load };
