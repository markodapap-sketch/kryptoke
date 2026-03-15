const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { getFirebase } = require('../services/firebase');
const { b2cSend } = require('../services/mpesa');
const { getWalletBalance, deriveUserWallet, USDT } = require('../services/bsc');
const { getKesPerUsd } = require('../services/forex');
const { ethers } = require('ethers');
const { v4: uuidv4 } = require('uuid');

// ── Limits ────────────────────────────────────────────────────────────────────
const DAILY_KES_LIMIT        = 150000;   // KES 150,000/day (~$1,150)
const MIN_KES_WITHDRAWAL     = 10;
const MIN_USDT_WITHDRAWAL    = 1;
const WITHDRAWAL_FEE_PERCENT = 1;        // 1% platform fee on withdrawals

// ── How much has this user withdrawn today (KES)? ─────────────────────────────
async function getKesWithdrawnToday(db, uid) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const snap = await db.collection('withdrawals')
    .where('uid', '==', uid)
    .where('type', '==', 'kes')
    .where('status', '==', 'completed')
    .where('createdAt', '>=', startOfDay.getTime())
    .get();

  let total = 0;
  snap.forEach(d => { total += d.data().amount || 0; });
  return total;
}

// ── POST /api/withdraw/kes — send KES to user via M-Pesa B2C ─────────────────
router.post('/kes', authMiddleware, async (req, res) => {
  const { amount, phone } = req.body;
  if (!amount || !phone) return res.status(400).json({ error: 'Amount and phone required' });
  if (amount < MIN_KES_WITHDRAWAL) return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_KES_WITHDRAWAL}` });

  const { db, rtdb } = getFirebase();
  const userRef  = db.collection('users').doc(req.user.uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });

  const user = userSnap.data();

  // KYC gate — require verified before withdrawing
  if (user.kycStatus !== 'verified') {
    return res.status(403).json({ error: 'Identity verification required before withdrawing. Complete KYC first.' });
  }

  // Balance check
  const kesBalance = user.balances?.KES || 0;
  if (kesBalance < amount) {
    return res.status(400).json({ error: `Insufficient KES balance. You have KES ${kesBalance.toFixed(2)}` });
  }

  // Daily limit check
  const withdrawnToday = await getKesWithdrawnToday(db, req.user.uid);
  if (withdrawnToday + amount > DAILY_KES_LIMIT) {
    const remaining = DAILY_KES_LIMIT - withdrawnToday;
    return res.status(400).json({ error: `Daily limit exceeded. You can withdraw KES ${remaining.toFixed(2)} more today.` });
  }

  // Calculate fee
  const fee        = amount * (WITHDRAWAL_FEE_PERCENT / 100);
  const netAmount  = Math.floor(amount - fee);  // Safaricom requires integer amounts
  const txId       = uuidv4();

  // Deduct balance immediately (optimistic) — refund if B2C fails
  await db.runTransaction(async tx => {
    const snap = await tx.get(userRef);
    const current = snap.data().balances?.KES || 0;
    if (current < amount) throw new Error('Insufficient balance');
    tx.update(userRef, { 'balances.KES': current - amount });
  });

  // Record withdrawal as pending
  await db.collection('withdrawals').doc(txId).set({
    txId,
    uid:       req.user.uid,
    type:      'kes',
    amount,
    fee,
    netAmount,
    phone,
    status:    'pending',
    createdAt: Date.now(),
  });

  // Fire B2C
  try {
    const result = await b2cSend({
      phone,
      amount:  netAmount,
      remarks: `KryptoKE Withdrawal ${txId.slice(0, 8).toUpperCase()}`,
    });

    await db.collection('withdrawals').doc(txId).update({
      b2cConversationId:      result.ConversationID,
      b2cOriginatorConvId:    result.OriginatorConversationID,
      status: 'processing',
    });

    res.json({
      txId,
      message:   `KES ${netAmount} will arrive on ${phone} shortly.`,
      fee:       `KES ${fee.toFixed(2)}`,
      netAmount,
    });

  } catch (e) {
    // Refund on B2C call failure
    await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      const current = snap.data().balances?.KES || 0;
      tx.update(userRef, { 'balances.KES': current + amount });
    });
    await db.collection('withdrawals').doc(txId).update({ status: 'failed', error: e.message });
    res.status(500).json({ error: `B2C failed: ${e.message}` });
  }
});

// ── B2C Result callback — Safaricom calls this on success/failure ─────────────
router.post('/b2c/result', async (req, res) => {
  // Respond immediately
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const { db, rtdb } = getFirebase();
    const result = req.body?.Result;
    if (!result) return;

    const { ConversationID, ResultCode, ResultDesc, ResultParameters } = result;

    // Find the withdrawal
    const snap = await db.collection('withdrawals')
      .where('b2cConversationId', '==', ConversationID)
      .limit(1).get();

    if (snap.empty) return;

    const doc        = snap.docs[0];
    const withdrawal = doc.data();

    if (ResultCode === 0) {
      // Parse result params
      const params = {};
      (ResultParameters?.ResultParameter || []).forEach(p => { params[p.Key] = p.Value; });

      await doc.ref.update({
        status:          'completed',
        mpesaRef:        params.TransactionReceipt,
        completedAt:     Date.now(),
        receiverPartyPub: params.ReceiverPartyPublicName,
      });

      // Real-time update to frontend
      await rtdb.ref(`withdrawals/${withdrawal.uid}/${doc.id}`).set({
        status:    'completed',
        amount:    withdrawal.netAmount,
        mpesaRef:  params.TransactionReceipt,
        ts:        Date.now(),
      });

    } else {
      // Refund on B2C failure
      const userRef = db.collection('users').doc(withdrawal.uid);
      await db.runTransaction(async tx => {
        const userSnap = await tx.get(userRef);
        const current  = userSnap.data().balances?.KES || 0;
        tx.update(userRef, { 'balances.KES': current + withdrawal.amount });
      });

      await doc.ref.update({ status: 'failed', resultDesc: ResultDesc, refundedAt: Date.now() });

      await rtdb.ref(`withdrawals/${withdrawal.uid}/${doc.id}`).set({
        status: 'failed',
        refunded: true,
        ts: Date.now(),
      });
    }
  } catch (err) {
    console.error('B2C result error:', err);
  }
});

// ── B2C Timeout callback ──────────────────────────────────────────────────────
router.post('/b2c/timeout', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  // Safaricom will retry — do nothing here, wait for result callback
  // If no result comes in 24h, a manual refund job should handle it
  console.warn('B2C timeout received:', JSON.stringify(req.body));
});

// ── GET /api/withdraw/status/:txId ────────────────────────────────────────────
router.get('/status/:txId', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('withdrawals').doc(req.params.txId).get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const d = snap.data();
  if (d.uid !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    status:    d.status,
    amount:    d.amount,
    netAmount: d.netAmount,
    fee:       d.fee,
    mpesaRef:  d.mpesaRef,
    createdAt: d.createdAt,
  });
});

// ── GET /api/withdraw/history ─────────────────────────────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('withdrawals')
    .where('uid', '==', req.user.uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  const list = [];
  snap.forEach(d => {
    const w = d.data();
    list.push({
      txId:      w.txId,
      type:      w.type,
      amount:    w.amount,
      netAmount: w.netAmount,
      fee:       w.fee,
      status:    w.status,
      mpesaRef:  w.mpesaRef,
      createdAt: w.createdAt,
    });
  });
  res.json({ withdrawals: list });
});

// ── GET /api/withdraw/limits ──────────────────────────────────────────────────
router.get('/limits', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const withdrawnToday = await getKesWithdrawnToday(db, req.user.uid);
  const kesPerUsd = await getKesPerUsd();

  res.json({
    dailyLimitKes:       DAILY_KES_LIMIT,
    usedTodayKes:        withdrawnToday,
    remainingTodayKes:   DAILY_KES_LIMIT - withdrawnToday,
    dailyLimitUsd:       (DAILY_KES_LIMIT / kesPerUsd).toFixed(2),
    feePercent:          WITHDRAWAL_FEE_PERCENT,
    minWithdrawalKes:    MIN_KES_WITHDRAWAL,
    kycRequired:         true,
  });
});

module.exports = router;