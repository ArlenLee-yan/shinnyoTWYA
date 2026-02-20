const line = require('@line/bot-sdk');
const db = require('../lib/firebase');

// LINE 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

export default async function handler(req, res) {
  // Vercel 只需要這一行來處理 GET 請求 (LINE Verify 用)
  if (req.method === 'GET') {
    return res.status(200).send('OK');
  }

  // 處理 POST 請求
  try {
    const events = req.body.events;
    if (events.length > 0) {
      await Promise.all(events.map(event => handleEvent(event)));
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
}

// --- 核心邏輯處理 ---
async function handleEvent(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  // 1. 初始化 / 讀取使用者狀態 (從 Firestore 讀，速度極快)
  // Collection: states, Document: userId
  const stateRef = db.collection('states').doc(userId);
  const userSnap = await stateRef.get();
  let userState = userSnap.exists ? userSnap.data() : {};

  // --- 邏輯分流 ---

  // 【情境 A】Postback (按鈕/日期)
  if (event.type === 'postback') {
    const data = event.postback.data;
    const params = event.postback.params;
    const payload = parseQueryString(data);

    // A-1. 選擇地點 -> 顯示日期選單
    if (payload.action === 'select_loc') {
      await replyDateMenu(replyToken, payload.val);
    }

    // A-2. 選擇日期 -> 顯示類別選單
    else if (payload.action === 'set_date') {
      let date = payload.val || (params && params.date ? params.date.replace(/-/g, '') : '');
      if (date) {
        const loc = payload.loc || "未知地點";
        await replyCategoryMenu(replyToken, loc, date);
      } else {
        await client.replyMessage(replyToken, { type: 'text', text: "❌ 日期抓取失敗" });
      }
    }

    // A-3. 選擇類別 -> 顯示實踐項目 (存入 Firestore)
    else if (payload.action === 'select_cat') {
      const newState = {
        step: 4,
        location: payload.loc || "未知",
        date: payload.date || "未知",
        category: payload.val,
        temp_items: []
      };
      await stateRef.set(newState); // 寫入 Firestore
      await replyItemMenu(replyToken, payload.val, []);
    }

    // A-4. 實踐項目切換 (複選邏輯)
    else if (payload.action === 'toggle_item') {
      if (!userState.step) {
        return client.replyMessage(replyToken, { type: 'text', text: "⚠️ 頁面逾時，請重新輸入「實績回報」。" });
      }

      const item = payload.val;
      let currentList = userState.temp_items || [];
      const idx = currentList.indexOf(item);
      if (idx > -1) { currentList.splice(idx, 1); } else { currentList.push(item); }

      // 更新 Firestore
      await stateRef.update({ temp_items: currentList });
      await replyItemMenu(replyToken, userState.category, currentList);
    }

    // A-5. 確認項目 -> 輸入說明
    else if (payload.action === 'confirm_items') {
      if (!userState.step) return;
      
      const finalItems = (userState.temp_items && userState.temp_items.length > 0) ? userState.temp_items.join(',') : '無';
      await stateRef.update({ step: 5, final_items: finalItems });
      
      await client.replyMessage(replyToken, { type: 'text', text: `已記錄項目：${finalItems}\n\n最後一步，請輸入實踐說明 (若無請輸入「無」)：` });
    }
  }

  // 【情境 B】文字輸入
  else if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // B-1. 入口指令
    if (text === '青年會資訊註冊') {
      const isRegistered = await checkUserIsRegistered(userId);
      if (isRegistered) {
        await client.replyMessage(replyToken, { type: 'text', text: "您已經註冊過了，無需重複註冊。\n請直接點擊「實績回報」。" });
      } else {
        await stateRef.set({ step: 'registering' });
        await client.replyMessage(replyToken, { type: 'text', text: "【歡迎新朋友】\n請直接輸入：\n部會 經名 姓名\n\n(例如：青年部 經親 王小明)" });
      }
      return;
    }

    if (text === '實績回報') {
      const isRegistered = await checkUserIsRegistered(userId);
      if (!isRegistered) {
        await client.replyMessage(replyToken, { type: 'text', text: "⚠️ 您尚未註冊。\n請先點選左側「青年會資訊註冊」完成資料登錄。" });
      } else {
        await replyLocationMenu(replyToken);
      }
      return;
    }

    // B-2. 註冊輸入
    if (userState.step === 'registering') {
      const parts = text.split(/\s+/);
      if (parts.length === 3) {
        // 寫入 Users Collection
        await db.collection('users').doc(userId).set({
          uid: userId,
          ministry: parts[0],
          sutra_name: parts[1],
          name: parts[2],
          reg_date: new Date()
        });
        
        await stateRef.delete(); // 清除狀態
        await client.replyMessage(replyToken, { type: 'text', text: `歡迎 ${parts[2]}！註冊成功。🎉\n\n現在您可以點擊選單右側的「實績回報」開始使用。` });
      } else {
        await client.replyMessage(replyToken, { type: 'text', text: "⚠️ 格式不對。\n請輸入三個詞，中間空格：\n部會 經名 姓名" });
      }
      return;
    }

    // B-3. 最後一步存檔
    if (userState.step === 5) {
      // 寫入 Records Collection
      await db.collection('records').add({
        uid: userId,
        location: userState.location,
        date: userState.date,
        category: userState.category,
        items: userState.final_items,
        description: text,
        created_at: new Date()
      });

      await stateRef.delete(); // 清除狀態
      await client.replyMessage(replyToken, { type: 'text', text: "🎉 實績回報完成！資料已儲存。" });
    }
  }
}

// --- 輔助函式 ---

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
    if (pair.length >= 2) {
      result[pair[0]] = decodeURIComponent(pair[1]);
    }
  }
  return result;
}

// --- UI 發送函式 (使用官方 SDK) ---
// 這裡的 JSON 結構跟 GAS 一模一樣，只是發送方式變了

async function replyLocationMenu(token) {
  const options = ["台灣本部", "中壢佈教所", "台中佈教所", "高雄佈教所", "雲林集會所", "花蓮集會所", "線上參加(直播)", "線上參加(VTR)", "其他"];
  const buttons = options.map(opt => ({
    type: "button", style: "secondary", height: "sm",
    action: { type: "postback", label: opt, data: `action=select_loc&val=${opt}` }
  }));
  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "步驟 1/5：請選擇參加地點", weight: "bold", color: "#1DB446" }] },
    body: { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇地點', contents: flex });
}

async function replyDateMenu(token, prevLoc) {
  const now = new Date();
  // 調整時區 +8 (Serverless 預設是 UTC)
  now.setHours(now.getHours() + 8);
  const todayStr = now.toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD
  const todayDisplay = now.toISOString().slice(5,10).replace('-','/'); // MM/DD
  
  const baseData = `action=set_date&loc=${prevLoc}`;
  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "步驟 2/5：請選擇實踐日期", weight: "bold", color: "#1DB446" }] },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "button", style: "primary", color: "#1DB446", action: { type: "postback", label: `今天 (${todayDisplay})`, data: `${baseData}&val=${todayStr}` } },
        { type: "button", style: "secondary", action: { type: "datetimepicker", label: "選擇其他日期", data: baseData, mode: "date" } }
      ]
    }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇日期', contents: flex });
}

async function replyCategoryMenu(token, prevLoc, prevDate) {
  const baseData = `action=select_cat&loc=${prevLoc}&date=${prevDate}`;
  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [{ type: "text", text: "步驟 3/5：請選擇登錄項目", weight: "bold", color: "#1DB446" }] },
    body: {
      type: "box", layout: "vertical", spacing: "md",
      contents: [
        { type: "button", style: "primary", action: { type: "postback", label: "青年會行事/活動(含VTR)", data: `${baseData}&val=青年會行事/活動(含VTR)` } },
        { type: "button", style: "primary", action: { type: "postback", label: "個人實踐項目 (可複選)", data: `${baseData}&val=個人實踐項目 (可複選)` } }
      ]
    }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇項目', contents: flex });
}

async function replyItemMenu(token, category, selectedList) {
  let options = [];
  if (category === "青年會行事/活動(含VTR)") {
    options = ["回歸聖地親苑", "6/9靈尊教導院祈念未來", "7/2靈尊真導院祈念未來", "8/6真如靈祖祈念未來", "7/19真如開祖祈念未來", "夏期鍊成第一天(8-9月)", "夏期鍊成第二天(9-10月)", "演講大會(9-10月)", "蛇瀧研修說明會(11-12月)", "青年經親說明會(12-1月)", "幹部委員說明會(12-1月)", "蛇瀧研修實績確認者說明會", "親子一體運動會", "其他"];
  } else {
    options = ["度眾", "歡喜", "奉侍", "舉辦青年家庭集會", "參加集會", "接心", "參加法會", "參加青年會合", "參加會座(初座/菩提會/本會座)", "參加幹部委員研修", "參加青年經親研修", "參加幹部會合", "參加部門會合", "參加信仰心向上會合", "拜讀一如之道究道篇(全)", "拜讀真如苑歷史", "參加總部會", "參加總部會會後會", "回歸聖地親苑", "其他"];
  }
  
  const buttons = options.map(opt => {
    const isSelected = selectedList.includes(opt);
    return {
      type: "button", style: isSelected ? "primary" : "secondary", color: isSelected ? "#1DB446" : "#aaaaaa", height: "sm",
      action: { type: "postback", label: isSelected ? `✅ ${opt}` : opt, data: `action=toggle_item&val=${opt}` }
    };
  });
  buttons.push({ type: "separator", margin: "md" });
  buttons.push({ type: "button", style: "link", height: "sm", action: { type: "postback", label: `確認送出 (${selectedList.length}項)`, data: "action=confirm_items" } });

  const flex = {
    type: "bubble",
    header: { type: "box", layout: "vertical", contents: [
      { type: "text", text: "步驟 4/5：實踐項目 (可複選)", weight: "bold", color: "#1DB446" },
      { type: "text", text: category, size: "xs", color: "#aaaaaa", wrap: true }
    ]},
    body: { type: "box", layout: "vertical", spacing: "sm", contents: buttons }
  };
  await client.replyMessage(token, { type: 'flex', altText: '請選擇細項', contents: flex });
}
```}

---

### 部署教學 (Deployment)

這是最關鍵的一步。我們不使用指令列，直接用網頁上傳最簡單。

1.  **上傳程式碼到 GitHub**：
    * 將這三個檔案推送到您 GitHub 的一個新倉庫 (Repo) 中。
    * *(如果您不熟悉 Git，也可以直接在 GitHub 網頁上 Create New Repository，然後手動 Create New File 把內容貼上去)*。

2.  **連結 Vercel**：
    * 登入 Vercel，點擊 **「Add New...」** -> **「Project」**。
    * 選擇您剛剛建立的 GitHub Repo，點擊 **「Import」**。

3.  **設定環境變數 (Environment Variables)**：
    * 在部署頁面的 **「Environment Variables」** 區塊，輸入以下 3 個變數 (非常重要！)：
        * `LINE_CHANNEL_ACCESS_TOKEN`: (填入您的 LINE Token)
        * `LINE_CHANNEL_SECRET`: (填入您的 LINE Secret)
        * `FIREBASE_CREDENTIALS`: (打開您剛剛下載的 Firebase JSON 檔案，**全選複製內容**，直接貼進去)

4.  **點擊 Deploy**：
    * 等待約 1 分鐘，看到滿版煙火畫面代表部署成功。
    * 複製 Vercel 給您的網址 (通常是 `https://您的專案名.vercel.app`)。

5.  **設定 LINE Webhook**：
    * 回到 LINE Developers Console。
    * Webhook URL 填入：`https://您的專案名.vercel.app/api/webhook` (注意後面要加 `/api/webhook`)。
    * 按 Verify。

**完成！**
現在您的 Bot 跑在 Vercel 的高速伺服器上，資料存在 Google 的 Firestore 裡。您可以體驗看看，速度絕對是飛快，點選按鈕幾乎沒有延遲。
