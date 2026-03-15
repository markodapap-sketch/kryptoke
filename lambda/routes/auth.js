const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getFirebase } = require('../services/firebase');
const { generateDepositAddress } = require('../services/bsc');

// ── Register ──────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, phone } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be 8+ characters' });

  const { db } = getFirebase();

  const existing = await db.collection('users').where('email', '==', email).limit(1).get();
  if (!existing.empty) return res.status(400).json({ error: 'Email already registered' });

  // Claim the next HD index atomically
  const counterRef = db.collection('meta').doc('hdCounter');
  let hdIndex;
  await db.runTransaction(async tx => {
    const snap = await tx.get(counterRef);
    hdIndex = snap.exists ? (snap.data().next || 0) : 0;
    tx.set(counterRef, { next: hdIndex + 1 }, { merge: true });
  });

  const depositAddress = await generateDepositAddress(hdIndex);
  const uid  = uuidv4();
  const hash = await bcrypt.hash(password, 10);

  const user = {
    uid,
    email,
    phone: phone || null,
    passwordHash: hash,
    hdIndex,                   // which derivation path this user owns
    depositAddress,            // their BSC deposit address (HD-derived)
    balances: {
      KES: 0,                  // fiat balance from M-Pesa
      USDT: 0,                 // internal USDT balance (post-KES conversion)
    },
    createdAt: Date.now(),
    kycStatus: 'pending',
  };

  await db.collection('users').doc(uid).set(user);

  const token = jwt.sign(
    { uid, email },
    process.env.JWT_SECRET || 'dex-secret-change-me',
    { expiresIn: '7d' }
  );

  // Never return private key or mnemonic — HD wallet, keys stay server-side
  res.json({
    token,
    user: {
      uid,
      email,
      phone,
      depositAddress,    // show the deposit address — NOT a private key
      kycStatus: 'pending',
    },
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { db } = getFirebase();

  const snap = await db.collection('users').where('email', '==', email).limit(1).get();
  if (snap.empty) return res.status(401).json({ error: 'Invalid credentials' });

  const user = snap.docs[0].data();
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign(
    { uid: user.uid, email },
    process.env.JWT_SECRET || 'dex-secret-change-me',
    { expiresIn: '7d' }
  );

  res.json({
    token,
    user: {
      uid: user.uid,
      email: user.email,
      phone: user.phone,
      depositAddress: user.depositAddress,
      kycStatus: user.kycStatus,
    },
  });
});

module.exports = router;