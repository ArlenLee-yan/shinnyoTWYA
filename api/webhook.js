const line = require('@line/bot-sdk');
const db = require('../lib/firebase');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// ★ 這裡請換成您剛剛部署 GAS 產生的網頁應用程式網址
const GAS_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycby9Qh3wbnLcrKZA_CxP31Cq8S00zjoWrmGgTIQWE4e8hubEIvYG-8P-mAnP2TUP67LOHg/exec';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('Method Not Allowed');

  try {
    const events = req.body.events;
    if (events && events.length > 0) {
      const firstEvent = events[0];
      if (firstEvent.replyToken === '00000000000000000000000000000000' || firstEvent.replyToken === 'ffffffffffffffffffffffffffffffff') {
        return res.status(200).send('OK');
      }

      await Promise.all(events.map(event => handleEvent(event)));
    }
    return res.status(200).send('OK');
  } catch (err) {
    console.error('執行錯誤:', err);
    return res.status(500).send(err.message);
  }
}

async function handleEvent(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  try {
    const stateRef = db.collection('states').doc(userId);
    const userSnap = await stateRef.get();
    let userState = userSnap.exists ? userSnap.data() : {};

    if (event.type === 'postback') {
      const data = event.postback.data;
      const params = event.postback.params;
      const payload = parseQueryString(data);

      if (payload.action === 'select_loc') {
        await replyDateMenu(replyToken, payload.val);
      }
      else if (payload.action === 'set_date') {
        let date = payload.val || (params && params.date ? params.date.replace(/-/g, '') : '');
        if (date) {
          await replyCategoryMenu(replyToken, payload.loc || "未知地點", date);
        } else {
          await client.replyMessage(replyToken, { type: 'text', text: "❌ 日期抓取失敗" });
        }
      }
      else if (payload.action === 'select_cat') {
        // 【優化】將資料庫寫入與 LINE 回覆同時進行
        const newState = { step: 4, location: payload.loc || "未知", date: payload.date || "未知", category: payload.val, temp_items: [] };
        await Promise.all([
          stateRef.set(newState),
          replyItemMenu(replyToken, payload.val, [])
        ]);
      }
      else if (payload.action === 'toggle_item') {
        if (!userState.step) return client.replyMessage(replyToken, { type: 'text', text: "⚠️ 頁面逾時，請重新輸入。" });
        const item = payload.val;
        let currentList = userState.temp_items || [];
        const idx = currentList.indexOf(item);
        if (idx > -1) { currentList.splice(idx, 1); } else { currentList.push(item); }
        
        // 【優化】並行處理
        await Promise.all([
          stateRef.update({ temp_items: currentList }),
          replyItemMenu(replyToken, userState.category, currentList)
        ]);
      }
      else if (payload.action === 'confirm_items') {
        if (!userState.step) return;
        const finalItems = (userState.temp_items && userState.temp_items.length > 0) ? userState.temp_items.join(',') : '無';
        
        // 【優化】並行處理
        await Promise.all([
          stateRef.update({ step: 5, final_items: finalItems }),
          client.replyMessage(replyToken, { type: 'text', text: `已記錄項目：${finalItems}\n\n最後一步，請輸入實踐說明 (若無請輸入「無」)：` })
        ]);
      }
    }

    else if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();

      if (text === '青年會資訊註冊') {
        const isRegistered = await checkUserIsRegistered(userId);
        if (isRegistered) {
          await client.replyMessage(replyToken, { type: 'text', text: "您已經註冊過了，無需重複註冊。" });
        } else {
          await Promise.all([
            stateRef.set({ step: 'registering' }),
            client.replyMessage(replyToken, { type: 'text', text: "【歡迎新朋友】\n請直接輸入：\n部會 經名 姓名" })
          ]);
        }
        return;
      }

      if (text === '實績回報') {
        const isRegistered = await checkUserIsRegistered(userId);
        if (!isRegistered) {
          await client.replyMessage(replyToken, { type: 'text', text: "⚠️ 您尚未註冊。" });
        } else {
          await replyLocationMenu(replyToken);
        }
        return;
      }

      if (userState.step === 'registering') {
        const parts = text.split(/\s+/);
        if (parts.length === 3) {
          const newUserData = { uid: userId, ministry: parts[0], sutra_name: parts[1], name: parts[2], reg_date: new Date().toISOString() };
          
          await Promise.all([
            db.collection('users').doc(userId).set(newUserData),
            stateRef.delete(),
            client.replyMessage(replyToken, { type: 'text', text: `歡迎 ${parts[2]}！註冊成功。🎉` }),
            // ★ 非同步呼叫 GAS，背景寫入試算表
            syncToGoogleSheets({ type: 'user', ...newUserData })
          ]);
        } else {
          await client.replyMessage(replyToken, { type: 'text', text: "⚠️ 格式不對。\n請輸入三個詞，中間空格。" });
        }
        return;
      }

      if (userState.step === 5) {
        const newRecordData = {
          uid: userId, location: userState.location, date: userState.date, category: userState.category,
          items: userState.final_items, description: text, created_at: new Date().toISOString()
        };

        await Promise.all([
          db.collection('records').add(newRecordData),
          stateRef.delete(),
          client.replyMessage(replyToken, { type: 'text', text: "🎉 實績回報完成！資料已儲存。" }),
          // ★ 非同步呼叫 GAS，背景寫入試算表
          syncToGoogleSheets({ type: 'record', ...newRecordData })
        ]);
      }
    }
  } catch (error) {
    console.error("處理事件時發生錯誤:", error);
  }
}

// --- 呼叫 GAS 的同步函式 ---
async function syncToGoogleSheets(data) {
  try {
    // Vercel 使用的 Node 18+ 原生支援 fetch
    await fetch(GAS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (err) {
    console.error("同步到 Google Sheets 失敗:", err);
    // 即使失敗也不會導致 LINE 回覆中斷
  }
}

// --- 以下輔助函式保持不變 ---
async function checkUserIsRegistered(userId) {
  const doc = await db.collection('users').doc(userId).get();
  return doc.exists;
}

function parseQueryString(query) {
  if (!query) return {};
  const vars = query.split('&');
  const result = {};
  for (let i = 0; i < vars.length; i++) {
    const pair = vars[i].split('=');
    if (pair.length >= 2) result[pair[0]] = decodeURIComponent(pair[1]);
  }
  return result;
}

// ... UI 發送函式 (replyLocationMenu 等) 請直接貼上您原本的程式碼，此處省略以節省版面 ...


```
