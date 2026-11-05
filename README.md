# LINE 群組訂餐

公司或社團在 LINE 群組訂便當、訂飲料時，不用再一則一則數訊息。

行政選好店家、發一張訂餐卡片到群組，同仁點卡片、勾選品項、送出。截止後行政打開就看得到兩張表：「給店家」的品項彙總，和「給收錢」的每人應付金額。

- **群組裡不放機器人，也不用推播額度**：卡片用行政本人的 LINE 帳號發出（LIFF `shareTargetPicker`）。
- **完全免費**：後端是 Google Apps Script，資料庫是 Google 試算表，前端放 GitHub Pages。讀菜單照片用 Gemini 的免費額度，這部分可以不用。
- **不用裝 App、不用註冊**：同仁用 LINE 登入，名字直接用 LINE 暱稱。

## 功能

- **開單**：從菜單庫選一家已經存過的店，或建一家新店。新店有兩種建法：
  - 上傳菜單照片，讓 Gemini 讀出草稿，行政再逐項校對。
  - 貼上別的 AI 整理好的菜單 JSON（格式見下方）。
- **點餐**：可選份量（小/大、便當/單點）和選項群組（甜度、冰塊、加料、雙拼選兩種……），每項都能寫備註。截止前可以隨時改或取消。
- **截止**：行政可以延後或提早截止，截止後同仁就不能再改。
- **暫停供應**：某個品項或某個選項當天沒有了（例如「麵條/烏龍」），行政按一下就能停掉。點餐頁會變灰，已經點到的人會用紅字列出來。
- **統計**：「給店家」把同樣的組合合在一起算數量，「給收錢」列出每人金額。截止後行政仍然可以幫任何人新增、修改或刪除。
- **月報**：選月份，看每人當月花了多少、各家店被訂了幾次。
- **多位行政**：在試算表的「成員」分頁勾選「行政」就有權限。

## 架構

```
LINE 群組 ── 訂餐卡片 ──> LIFF 頁（GitHub Pages：web/）
                              │  fetch（text/plain，不觸發 CORS preflight）
                              ▼
                        Apps Script Web App（gas/）── Google 試算表
                              │
                              ├─ LINE：驗證 ID token
                              └─ Gemini：讀菜單照片（可不用）
```

- 身分只採信後端向 LINE 驗證過的 ID token，前端送來的名字一律不用。沒有行政權限的人呼叫行政動作，後端會擋下。
- `gas/Logic.js`（菜單正規化、統計）和 `gas/Handlers.js`（API、權限、截止判斷）三邊共用：Apps Script、瀏覽器 demo、node 測試。所以這兩個檔案的頂層只能寫 `function` 和 `var`。
- LIFF 頁不放在 Apps Script 的 HtmlService，因為它會把頁面包進 iframe，LIFF 常常初始化失敗。
- 寫入試算表時，使用者輸入的開頭如果是 `= + - @`，會先加上單引號，避免被當成公式執行。

## 安裝

照 [安裝說明.md](安裝說明.md) 一步一步做，大約 30 分鐘。需要 Google、LINE、GitHub 三個帳號，以及 Node.js（用來跑 clasp）。

## 不用 LINE 先試玩

```bash
python -m http.server 8765
```

打開下面兩個網址：

- `http://localhost:8765/web/index.html?demo=1&as=admin`：當行政。
- `http://localhost:8765/web/index.html?demo=1&o=demo1&as=alice`：當同仁點餐。

demo 模式把資料存在瀏覽器裡，網址加 `&reset=1` 可以清掉。

## 菜單格式

```json
{
  "name": "店名",
  "groups": [ 全店共用的選項群組 ],
  "categories": [
    {
      "name": "分類名",
      "groups": [ 這個分類共用的選項群組 ],
      "items": [
        { "name": "品名", "price": 100 },
        { "name": "品名", "variants": [{ "label": "小", "price": 50 }, { "label": "大", "price": 60 }] },
        { "name": "品名", "price": 120, "groups": [ 這個品項自己的選項群組 ] }
      ]
    }
  ]
}
```

選項群組長這樣：`{ "name": "甜度", "min": 1, "max": 1, "choices": [{ "label": "半糖" }, { "label": "加珍珠", "delta": 10 }] }`。`min`／`max` 是至少選幾個、最多選幾個，`delta` 是加價。

- 全店、分類、品項三層的群組會合併到每個品項上；同名的群組以品項自己的為準。
- 整份菜單的品名不能重複。店家把「單點」另外列一個價錢時，請併成同一個品項的份量，例如 `便當 / 單點`。
- 完整範例見 [menus/範例便當店.json](menus/範例便當店.json)。

### 一次匯入好幾家

1. 把菜單存成 `menus/店名.json`。
2. 執行 `node tools/build-import.js 店名1 店名2`，產生 `gas/ImportMenus.js`。
3. 執行 `clasp push`。
4. 在 Apps Script 編輯器左邊**先點 `Setup.gs`**，函式選 `importMenus`，按「執行」。

同名的店會整份更新菜單，沒有的店會新增。只要有任何一份菜單有問題，整批都不會寫入。

## 測試

```bash
node --test
```

測試用假的 SpreadsheetApp／PropertiesService 跑真正的 `gas/*.js`，不用連網路。

## 踩過的坑

- **Gemini 模型會退役**：舊型號對新金鑰會回 404，所以預設用別名 `gemini-flash-latest`，要固定版本才在指令碼屬性填 `GEMINI_MODEL`。尖峰時段常回 503，程式會重試一次，還不行就換 `gemini-flash-lite-latest`。
- **3.x 系列的 Flash 預設會先思考**，一次呼叫可能卡好幾分鐘，所以程式設了 `thinkingLevel: 'low'`。
- **LINE 內建瀏覽器會快取舊的 JS**：更新前端後如果手機上還是舊版，請在 `web/index.html` 引用的 js、css 網址後面加 `?v=日期`。
- **用 curl 測 `/exec` 時不要加 `-X POST`**，否則 302 轉址後還送 POST 會回 411。要用 `curl -sL -d '...'`。

## 授權

MIT
