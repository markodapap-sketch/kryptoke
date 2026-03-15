const admin = require('firebase-admin');

let db, rtdb;

function getFirebase() {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
  }
  if (!db) db = admin.firestore();
  if (!rtdb) rtdb = admin.database();
  return { db, rtdb, admin };
}

module.exports = { getFirebase };
