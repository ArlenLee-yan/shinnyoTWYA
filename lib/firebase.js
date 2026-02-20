const admin = require('firebase-admin');

// 防止重複初始化
if (!admin.apps.length) {
  // 這裡我們會從環境變數讀取金鑰，確保安全
  const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

module.exports = db;
