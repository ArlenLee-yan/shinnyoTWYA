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
      
      else if (payload.action === 'select_item_single') {
        if (!userState.step) return client.replyMessage(replyToken, { type: 'text', text: "⚠️ 頁面逾時，請重新輸入。" });
        await processFinalItems(userId, replyToken, stateRef, userState, payload.val);
      }

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
      
      else if (payload.action === 'confirm_items') {
        if (!userState.step) return;
        const finalItems = (userState.temp_items && userState.temp_items.length > 0) ? userState.temp_items.join(',') : '無';
        await processFinalItems(userId, replyToken, stateRef, userState, finalItems);
      }

      else if (payload.action === 'select_service_single') {
        if (!userState.step) return client.replyMessage(replyToken, { type: 'text', text: "⚠️ 頁面逾時，請重新輸入。" });
        
        const selectedService = payload.val;
        const hasOther = selectedService === '其他';

        if (hasOther) {
           await Promise.all([
            stateRef.update({ step: 4.6, final_services: selectedService }),
            client.replyMessage(replyToken, { type: 'text', text: `已記錄法會：${selectedService}\n\n您選擇了「其他」，請輸入法會詳細說明：` })
          ]);
        } else {
           await saveRecordToDB(userId, replyToken, stateRef, userState, {
            services: selectedService,
            service_desc: '無',
            description: '無'
          });
        }
      }
    }

    else if (event.type === 'message' && event.message.type === 'text') {
      const text = event.message.text.trim();

      if (text === '實績查詢') {
        const isRegistered = await checkUserIsRegistered(userId);
        if (!isRegistered) {
          await client.replyMessage(replyToken, { type: 'text', text: "⚠️ 您尚未註冊。" });
          return;
        }

        const snapshot = await db.collection('records').where('uid', '==', userId).get();
        
        const categoryA_counts = {};
        const categoryB_counts = {};
        const service_counts = {}; 

        snapshot.forEach(doc => {
          const data = doc.data();
          const rDate = data.date; 
          
          if (rDate && rDate >= '20260501' && rDate <= '20270430') {
            const itemsStr = data.items || '';
            const servicesStr = data.services || '';

            if (itemsStr && itemsStr !== '無') {
              const itemsArr = itemsStr.split(',');
              if (data.category === '青年會行事/活動(含VTR)') {
                itemsArr.forEach(item => {
                  if (item !== '其他') categoryA_counts[item] = (categoryA_counts[item] || 0) + 1;
                });
              } else if (data.category === '個人實踐項目 (可複選)') {
                itemsArr.forEach(item => {
                  if (item !== '其他') categoryB_counts[item] = (categoryB_counts[item] || 0) + 1;
                });
              }
            }

            if (servicesStr && servicesStr !== '無') {
               if (servicesStr !== '其他') service_counts[servicesStr] = (service_counts[servicesStr] || 0) + 1;
            }
          }
        });

        let replyText = "以下是您青年會2026年度實績回報資料\n\n";
        
        replyText += "青年會行事/活動：\n";
        const keysA = Object.keys(categoryA_counts);
        if (keysA.length === 0) replyText += "無\n";
        else keysA.forEach(k => { replyText += `${k}共${categoryA_counts[k]}次\n`; });

        replyText += "\n實踐項目：\n";
        const keysB = Object.keys(categoryB_counts);
        if (keysB.length === 0) replyText += "無\n";
        else keysB.forEach(k => { replyText += `${k}共${categoryB_counts[k]}次\n`; });

        replyText += "\n法會參與：\n";
        const keysS = Object.keys(service_counts);
        if (keysS.length === 0) replyText += "無\n";
        else keysS.forEach(k => { replyText += `${k}共${service_counts[k]}次\n`; });

        await client.replyMessage(replyToken, { type: 'text', text: replyText.trim() });
        return;
      }

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
          const newUserData = { uid: userId, ministry: parts[0], sutra_name: parts[1], name: parts[2], reg_date: getTaiwanTime() };
          
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

      if (userState.step === 4.6) {
        await saveRecordToDB(userId, replyToken, stateRef, userState, {
          services: userState.final_services || '無',
          service_desc: text,
          description: '無'
        });
        return;
      }

      if (userState.step === 5) {
        await saveRecordToDB(userId, replyToken, stateRef, userState, {
          services: '無',
          service_desc: '無',
          description: text
        });
        return;
      }
    }
  } catch (error) {
    console.error("處理事件時發生錯誤:", error);
  }
}

async function processFinalItems(userId, replyToken, stateRef, userState, finalItemsStr) {
  const isCategoryB = userState.category === '個人實踐項目 (可複選)';
  const hasService = finalItemsStr.includes('參加法會');

  if (isCategoryB && hasService) {
    await Promise.all([
      stateRef.update({ step: 4.5, final_items: finalItemsStr }),
      replyServiceMenu(replyToken)
    ]);
    return; 
  }

  const hasOther = finalItemsStr.includes('其他');

  if (hasOther) {
    await Promise.all([
      stateRef.update({ step: 5, final_items: finalItemsStr }),
      client.replyMessage(replyToken, { type: 'text', text: `已記錄項目：${finalItemsStr}\n\n您選擇了「其他」，請輸入詳細說明：` })
    ]);
  } else {
    // ★ 修正：將直接送出的項目賦值給 userState，確保 saveRecordToDB 抓得到最新的值
    userState.final_items = finalItemsStr;
    await saveRecordToDB(userId, replyToken, stateRef, userState, {
      services: '無',
      service_desc: '無',
      description: '無'
    });
  }
}

async function saveRecordToDB(userId, replyToken, stateRef, userState, extraFields) {
  const newRecordData = {
    uid: userId, 
    location: userState.location, 
    date: userState.date, 
    category: userState.category,
    items: userState.final_items || '無', 
    services: extraFields.services,
    service_desc: extraFields.service_desc,
    description: extraFields.description, 
    created_at: getTaiwanTime()
  };

  await Promise.all([
    db.collection('records').add(newRecordData),
    stateRef.delete(),
    client.replyMessage(replyToken, { type: 'text', text: "🎉 實績回報完成！資料已儲存。" }),
    syncToGoogleSheets({ 
      type: 'record', 
      ...newRecordData, 
      description: "'" + newRecordData.description,
      service_desc: "'" + newRecordData.service_desc 
    })
  ]);
}

function getTaiwanTime() {
  const now = new Date();
  now.setHours(now.getHours() + 8); 
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const min = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}/${m}/${d} ${h}:${min}:${s}`;
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
    options = ["度眾", "歡喜", "奉侍", "舉辦青年家庭集會", "參加集會", "接心", "參加法會", "參加青年會合", "參加會座(初座/菩提會/本會座)", "參加幹部委員研修", "參加青年經親研修", "參加幹部會合", "參加部門會合", "參加信仰心向上會合", "拜讀一如之道究道篇(全)", "拜讀真如苑歷史", "參加總部會", "參加總部會會後會", "回歸聖地親苑"];
  }
  
  const buttons = options.map(opt => {
    if (isSingleChoice) {
      return {
        type: "button", style: "secondary", height: "sm",
        action: { type: "postback", label: opt, data: `action=select_item_single&val=${opt}` }
      };
    } else {
      const isSelected = selectedList.includes(opt);
      return {
        type: "button", style: isSelected ? "primary" : "secondary", color: isSelected ? "#1DB446" : "#aaaaaa", height: "sm",
        action: { type: "postback", label: isSelected ? `✅ ${opt}` : opt, data: `action=toggle_item&val=${opt}` }
      };
    }
  });

  buttons.push({ type: "separator", margin: "md" });
  
  if (!isSingleChoice) {
    buttons.push({ type: "button", style: "link", height: "sm", action: { type: "postback", label: `確認送出 (${selectedList.length}項)`, data: "action=confirm_items" } });
  }

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

async function replyServiceMenu(token) {
  const options = [
    "真如教主 120 歲誕辰慶典（3/28）",
    "真導院 89 歲誕辰慶典（4/8）",
    "靈廟莊嚴祈誓 真如濟攝會 （4/18）",
    "One Heart 慶典-真如繼主慶生會（4/25）",
    "攝受心院 114 歲誕辰慶典（5/9）",
    "靈尊教導院・定心法會（6/9）",
    "靈尊真導院・成行法會（7/2）",
    "真如開祖・恆明法會（7/19）",
    "教導院 92 歲誕辰慶典（7/29）",
    "真如靈祖・湧祥法會（8/6）",
    "其他"
  ];
  
  const buttons = options.map(opt => {
    return {
      type: "button", style: "secondary", height: "sm",
      action: { type: "postback", label: opt, data: `action=select_service_single&val=${opt}` }
    };
  });

  buttons.push({ type: "separator", margin: "md" });
  buttons.push({
    type: "button", style: "primary", color: "#EF454D", height: "sm", margin: "sm",
    action: { type: "postback", label: "🚫 取消本次輸入", data: "action=cancel_input" }
  });

  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "附加選項：請選擇法會項目 (單選)", weight: "bold", color: "#1DB446" }]},
    body: { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇法會項目', contents: flex });
}
