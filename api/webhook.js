const line = require('@line/bot-sdk');
const db = require('../lib/firebase');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// ★ 記得替換成您的 GAS Webhook 網址
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

  showLoadingAnimation(userId).catch(console.error);

  try {
    const stateRef = db.collection('states').doc(userId);
    const userSnap = await stateRef.get();
    let userState = userSnap.exists ? userSnap.data() : {};

    if (event.type === 'postback') {
      const data = event.postback.data;
      const params = event.postback.params;
      const payload = parseQueryString(data);

      // ★ 新增：中斷並取消輸入
      if (payload.action === 'cancel_input') {
        await Promise.all([
          stateRef.delete(),
          client.replyMessage(replyToken, { type: 'text', text: "🚫 已取消本次實績回報。" })
        ]);
        return;
      }

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
        const newState = { step: 4, location: payload.loc || "未知", date: payload.date || "未知", category: payload.val, temp_items: [] };
        await Promise.all([
          stateRef.set(newState),
          replyItemMenu(replyToken, payload.val, [])
        ]);
      }
      
      // ★ 新增：單選項目直接送出
      else if (payload.action === 'select_item_single') {
        if (!userState.step) return client.replyMessage(replyToken, { type: 'text', text: "⚠️ 頁面逾時，請重新輸入。" });
        await processFinalItems(userId, replyToken, stateRef, userState, payload.val);
      }

      // 複選項目的切換邏輯
      else if (payload.action === 'toggle_item') {
        if (!userState.step) return client.replyMessage(replyToken, { type: 'text', text: "⚠️ 頁面逾時，請重新輸入。" });
        const item = payload.val;
        let currentList = userState.temp_items || [];
        const idx = currentList.indexOf(item);
        if (idx > -1) { currentList.splice(idx, 1); } else { currentList.push(item); }
        
        await Promise.all([
          stateRef.update({ temp_items: currentList }),
          replyItemMenu(replyToken, userState.category, currentList)
        ]);
      }
      
      // 複選項目的確認送出邏輯
      else if (payload.action === 'confirm_items') {
        if (!userState.step) return;
        const finalItems = (userState.temp_items && userState.temp_items.length > 0) ? userState.temp_items.join(',') : '無';
        await processFinalItems(userId, replyToken, stateRef, userState, finalItems);
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
            client.replyMessage(replyToken, { type: 'text', text: "【歡迎新青年】\n請直接輸入：\n部會 經名 姓名\n範例：台灣一部 王大明 王小明" })
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
          syncToGoogleSheets({ type: 'record', ...newRecordData })
        ]);
      }
    }
  } catch (error) {
    console.error("處理事件時發生錯誤:", error);
  }
}

// ★ 新增：將最後確認的邏輯獨立出來，讓單選跟複選共用
async function processFinalItems(userId, replyToken, stateRef, userState, finalItemsStr) {
  const hasOther = finalItemsStr.includes('其他');

  if (hasOther) {
    await Promise.all([
      stateRef.update({ step: 5, final_items: finalItemsStr }),
      client.replyMessage(replyToken, { type: 'text', text: `已記錄項目：${finalItemsStr}\n\n您選擇了「其他」，請輸入詳細說明：` })
    ]);
  } else {
    const newRecordData = {
      uid: userId, 
      location: userState.location, 
      date: userState.date, 
      category: userState.category,
      items: finalItemsStr, 
      description: '無', 
      created_at: new Date().toISOString()
    };

    await Promise.all([
      db.collection('records').add(newRecordData),
      stateRef.delete(),
      client.replyMessage(replyToken, { type: 'text', text: `已記錄項目：${finalItemsStr}\n\n🎉 實績回報完成！資料已儲存。` }),
      syncToGoogleSheets({ type: 'record', ...newRecordData })
    ]);
  }
}

async function showLoadingAnimation(userId) {
  try {
    await fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ chatId: userId, loadingSeconds: 5 })
    });
  } catch (err) {
    console.error("Loading animation 觸發失敗:", err);
  }
}

async function syncToGoogleSheets(data) {
  try {
    await fetch(GAS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (err) {
    console.error("同步到 Google Sheets 失敗:", err);
  }
}

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

async function replyLocationMenu(token) {
  const options = ["台灣本部", "中壢佈教所", "台中佈教所", "高雄佈教所", "雲林集會所", "花蓮集會所", "線上參加(直播)", "線上參加(VTR)", "其他"];
  const buttons = options.map(opt => ({
    type: "button", style: "secondary", height: "sm",
    action: { type: "postback", label: opt, data: `action=select_loc&val=${opt}` }
  }));
  
  // 地點選單加入取消按鈕
  buttons.push({ type: "separator", margin: "md" });
  buttons.push({
    type: "button", style: "primary", color: "#EF454D", height: "sm", margin: "sm",
    action: { type: "postback", label: "🚫 取消本次輸入", data: "action=cancel_input" }
  });

  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "步驟 1/5：請選擇參加地點", weight: "bold", color: "#1DB446" }] },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇地點', contents: flex });
}

async function replyDateMenu(token, prevLoc) {
  const now = new Date();
  now.setHours(now.getHours() + 8);
  const todayStr = now.toISOString().slice(0,10).replace(/-/g,''); 
  const todayDisplay = now.toISOString().slice(5,10).replace('-','/'); 
  
  const baseData = `action=set_date&loc=${prevLoc}`;
  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "步驟 2/5：請選擇實踐日期", weight: "bold", color: "#1DB446" }] },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: `今天 (${todayDisplay})`, data: `${baseData}&val=${todayStr}` } },
        { type: "button", style: "secondary", action: { type: "datetimepicker", label: "選擇其他日期", data: baseData, mode: "date" } },
        { type: "separator", margin: "md" },
        { type: "button", style: "primary", color: "#EF454D", action: { type: "postback", label: "🚫 取消本次輸入", data: "action=cancel_input" } }
      ]
    }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇日期', contents: flex });
}

async function replyCategoryMenu(token, prevLoc, prevDate) {
  const baseData = `action=select_cat&loc=${prevLoc}&date=${prevDate}`;
  const formattedDate = prevDate.length === 8 ? `${prevDate.substring(0,4)}/${prevDate.substring(4,6)}/${prevDate.substring(6,8)}` : prevDate;

  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "步驟 3/5：請選擇登錄項目", weight: "bold", color: "#1DB446" }] },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "button", style: "primary", action: { type: "postback", label: "青年會行事/活動(含VTR)", data: `${baseData}&val=青年會行事/活動(含VTR)` } },
        { type: "button", style: "primary", action: { type: "postback", label: "個人實踐項目 (可複選)", data: `${baseData}&val=個人實踐項目 (可複選)` } },
        { type: "separator", margin: "md" },
        { type: "button", style: "primary", color: "#EF454D", action: { type: "postback", label: "🚫 取消本次輸入", data: "action=cancel_input" } }
      ]
    }
  };
  
  await client.replyMessage(token, [
    { type: 'text', text: `📍 地點：${prevLoc}\n📅 日期：${formattedDate}` },
    { type: 'flex', altText: '請選擇項目', contents: flex }
  ]);
}

async function replyItemMenu(token, category, selectedList) {
  let options = [];
  const isSingleChoice = (category === "青年會行事/活動(含VTR)");

  if (isSingleChoice) {
    options = ["回歸聖地親苑", "6/9靈尊教導院祈念未來", "7/2靈尊真導院祈念未來", "8/6真如靈祖祈念未來", "7/19真如開祖祈念未來", "夏期鍊成第一天(8-9月)", "夏期鍊成第二天(9-10月)", "演講大會(9-10月)", "蛇瀧研修說明會(11-12月)", "青年經親說明會(12-1月)", "幹部委員說明會(12-1月)", "蛇瀧研修實績確認者說明會", "親子一體運動會", "其他"];
  } else {
    options = ["度眾", "歡喜", "奉侍", "舉辦青年家庭集會", "參加集會", "接心", "參加法會", "參加青年會合", "參加會座(初座/菩提會/本會座)", "參加幹部委員研修", "參加青年經親研修", "參加幹部會合", "參加部門會合", "參加信仰心向上會合", "拜讀一如之道究道篇(全)", "拜讀真如苑歷史", "參加總部會", "參加總部會會後會", "回歸聖地親苑", "其他"];
  }
  
  const buttons = options.map(opt => {
    if (isSingleChoice) {
      // 單選按鈕：綁定 select_item_single，點擊直接送出
      return {
        type: "button", style: "secondary", height: "sm",
        action: { type: "postback", label: opt, data: `action=select_item_single&val=${opt}` }
      };
    } else {
      // 複選按鈕：維持打勾邏輯
      const isSelected = selectedList.includes(opt);
      return {
        type: "button", style: isSelected ? "primary" : "secondary", color: isSelected ? "#1DB446" : "#aaaaaa", height: "sm",
        action: { type: "postback", label: isSelected ? `✅ ${opt}` : opt, data: `action=toggle_item&val=${opt}` }
      };
    }
  });

  buttons.push({ type: "separator", margin: "md" });
  
  // 只有「複選」才需要產生「確認送出」按鈕
  if (!isSingleChoice) {
    buttons.push({ type: "button", style: "link", height: "sm", action: { type: "postback", label: `確認送出 (${selectedList.length}項)`, data: "action=confirm_items" } });
  }

  // ★ 新增：無論單選複選，都加入紅色取消按鈕
  buttons.push({
    type: "button", style: "primary", color: "#EF454D", height: "sm", margin: "sm",
    action: { type: "postback", label: "🚫 取消本次輸入", data: "action=cancel_input" }
  });

  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [
      { type: "text", text: `步驟 4/5：實踐項目 ${isSingleChoice ? "(單選)" : "(可複選)"}`, weight: "bold", color: "#1DB446" },
      { type: "text", text: category, size: "xs", color: "#aaaaaa", wrap: true }
    ]},
    body: { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇細項', contents: flex });
}
