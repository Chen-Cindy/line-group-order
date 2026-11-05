// Web App 進入點：doPost 是前端唯一的 JSON API。前端用 text/plain 送，避免 CORS preflight。

function doGet() {
  return json_({ ok: true, data: 'line-order' });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var identity = verifyIdToken_(req.idToken);
    var deps = { db: SheetDb(), readMenu: readMenuWithGemini_ };
    return json_({ ok: true, data: handle(String(req.action || ''), req.payload || {}, identity, deps, Date.now()) });
  } catch (err) {
    if (!err.code) console.error((err && err.stack) || err);
    return json_({ ok: false, code: err.code || 'INVALID', error: err.code ? err.message : '系統錯誤，請稍後再試' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// 向 LINE 驗證 LIFF 的 ID token；只有這裡拿到的 userId、暱稱才算數
function verifyIdToken_(idToken) {
  if (!idToken) throw appError('UNAUTHORIZED', '請重新登入');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(idToken));
  var key = 'tok:' + digest.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: String(idToken), client_id: prop_('LINE_CHANNEL_ID') },
    muteHttpExceptions: true
  });
  // 只有 400（token 無效或過期）才叫前端重新登入；LINE 本身故障不能讓前端一直重登
  if (res.getResponseCode() === 400) throw appError('UNAUTHORIZED', '登入已過期，請重新開啟');
  if (res.getResponseCode() !== 200) throw new Error('LINE 驗證服務回應 ' + res.getResponseCode());
  var t = JSON.parse(res.getContentText());
  var who = { userId: String(t.sub), name: String(t.name || 'LINE 使用者') };
  var ttl = Math.min(600, Math.floor(t.exp - Date.now() / 1000));
  if (ttl > 0) cache.put(key, JSON.stringify(who), ttl);
  return who;
}

var MENU_PROMPT_ = [
  '你是菜單整理助手。請讀這些菜單照片，只輸出 JSON，格式如下：',
  '{"groups":[全菜單共用的選項],"categories":[{"name":"分類名","groups":[只適用這個分類的共用選項],' +
    '"items":[{"name":"品名","variants":[{"label":"份量，只有一種價格就填空字串","price":數字}],' +
    '"groups":[{"name":"選項名","min":最少選幾個,"max":最多選幾個,"choices":[{"label":"選項","delta":加價數字}]}],"unsure":false}]}]}',
  '規則：',
  '1. 一個都不能漏：照片上每一個分區、每一個品項都要輸出。多欄排版要一欄一欄、由上而下讀完。',
  '2. 照菜單上的分區分類。分類名稱只寫分區標題本身（例如「飲中甜品」），不要接上副標、英文或活動字樣。',
  '3. 同一品項有多種份量或價格（M／L／瓶、全／半／1/4、大／小、份／條）時，每種放一個 variants。' +
    '價格欄是「-」或空白代表沒有賣這個份量：不要輸出那個 variant。',
  '4. 「任選 N 種」「雙拼選兩種」這類要顧客自己挑的，放進該品項的 groups，min 和 max 都填 N。',
  '5. 全菜單共用的選項（例如糖量表、冰量表、所有飲料都能加的配料）放在最外層 groups；只適用某個分類的，放在那個分類的 groups。' +
    '甜度、冰塊這種一定要選一個的 min=1、max=1；配料這種可加可不加的 min=0、max 填選項數，加價寫在 delta。',
  '6. 標示「甜度固定」「冰量固定」的分類或品項，在它的 groups 放同名、只有一個選項「固定」的選項（min=1、max=1）。',
  '7. 三寶、四寶這類固定搭配、不能改的，當一般品項，不要加 groups。可以單獨點的配菜（例如白飯、滷蛋）也當一般品項。',
  '8. price、delta 只填數字，不含 $ 或「元」。看不清楚或不確定的品項，把 unsure 設成 true。',
  '9. 只輸出照片上真的有的餐點，不要自己編造；地址、電話、營業時間、優惠活動不要輸出。',
  '10. 品名用照片上的繁體中文原文，不要附英文。'
].join('\n');

var GEMINI_FALLBACK_MODEL_ = 'gemini-flash-lite-latest';
var GEMINI_BUSY_CODES_ = { 429: true, 500: true, 503: true };

// 503/500/429 多半是 Google 那邊暫時太忙：同一個模型等一下再試，還不行就換 Flash-Lite；其他錯誤重試也沒用
function readMenuWithGemini_(images) {
  var key = prop_('GEMINI_API_KEY');
  if (!key) throw appError('AI_FAILED', '還沒設定 Gemini 金鑰，請先改用手動輸入');
  // 預設用 Google 維護的別名：Flash 版本幾個月就換一次（2.5 已不開放給新金鑰，回 404），別名會自動指向現行版本
  var primary = prop_('GEMINI_MODEL') || 'gemini-flash-latest';
  var plan = [primary, primary, GEMINI_FALLBACK_MODEL_];
  var r, t0 = Date.now();
  for (var i = 0; i < plan.length; i++) {
    if (i > 0) {
      if (Date.now() - t0 > 60000) break; // 已經等超過一分鐘就不再重試，前端 100 秒會放棄
      Utilities.sleep(2000 * i);
    }
    var t = Date.now();
    r = callGemini_(plan[i], key, images);
    console.log('Gemini ' + plan[i] + ' ' + (Date.now() - t) + 'ms ' + (r.menu ? 'ok ' + JSON.stringify(r.menu._ai) : r.reason));
    if (r.menu) return r.menu;
    if (r.code === 404 && i === 0) { i = 1; continue; } // 模型不存在就別再試同一個，直接換 Flash-Lite
    if (!GEMINI_BUSY_CODES_[r.code]) break;
  }
  throw appError('AI_FAILED', 'AI 讀菜單失敗（' + str_(r.reason) + '），請稍後再試，或改用手動輸入');
}

// 打一次 Gemini：成功回 {menu}；失敗回 {code, reason}，reason 會顯示給行政看（狀態碼、模型、截斷原因）
function callGemini_(model, key, images) {
  var parts = [{ text: MENU_PROMPT_ }].concat(images.map(function (img) {
    return { inline_data: { mime_type: img.mimeType, data: img.data } };
  }));
  var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify({
      contents: [{ parts: parts }],
      // 3.x Flash 預設會先「思考」，抄菜單用不到還會拖到好幾分鐘；low 是 3.8 也接受的最低檔（minimal 會被拒）
      generationConfig: { responseMimeType: 'application/json', temperature: 0, thinkingConfig: { thinkingLevel: 'low' } }
    }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode(), text = res.getContentText(), reason = 'HTTP ' + code;
  try {
    var body = JSON.parse(text);
    if (code !== 200) {
      reason += ' ' + ((body.error && body.error.status) || '');
      if (code === 404) reason += '，模型 ' + model; // 404 幾乎都是模型名稱被停用
    } else {
      var cand = (body.candidates || [])[0] || {};
      var part = ((cand.content && cand.content.parts) || []).filter(function (p) { return p.text && !p.thought; })[0];
      try {
        var menu = JSON.parse(part.text);
        if (isObj_(menu)) {
          // 給校對頁的摘要用：實際回答的模型版本、結束原因、輸出長度
          menu._ai = { model: body.modelVersion || model, finishReason: cand.finishReason || '',
            outputTokens: (body.usageMetadata && body.usageMetadata.candidatesTokenCount) || 0 };
        }
        return { menu: menu };
      } catch (e) {
        reason = '回傳不完整 ' + (cand.finishReason || (body.promptFeedback && body.promptFeedback.blockReason) || '');
      }
    }
  } catch (e) { /* 回應不是 JSON，reason 維持 HTTP 狀態碼 */ }
  console.error('Gemini 失敗（' + model + '）：' + reason + '｜' + text.slice(0, 500));
  return { code: code, reason: reason };
}
