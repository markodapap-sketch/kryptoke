const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { getFirebase } = require('../services/firebase');
const { stkPush, b2cSend } = require('../services/mpesa');
const { getKesPerUsd } = require('../services/forex');
const { v4: uuidv4 } = require('uuid');

// ── Initiate M-Pesa deposit ───────────────────────────────────────────────────
router.post('/deposit', authMiddleware, async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount) return res.status(400).json({ error: 'Phone and amount required' });
  if (amount < 10) return res.status(400).json({ error: 'Minimum deposit is KES 10' });

  const { db } = getFirebase();
  const txId = uuidv4();

  await db.collection('deposits').doc(txId).set({
    txId,
    uid: req.user.uid,
    phone,
    amount,
    status: 'pending',
    type: 'mpesa',
    createdAt: Date.now(),
  });

  try {
    const result = await stkPush({
      phone,
      amount,
      accountRef: txId.slice(0, 12).toUpperCase(),
      description: 'KryptoKE Deposit',
    });

    await db.collection('deposits').doc(txId).update({
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
    });

    res.json({
      txId,
      checkoutRequestId: result.CheckoutRequestID,
      message: 'STK Push sent. Enter your M-Pesa PIN.',
    });
  } catch (e) {
    await db.collection('deposits').doc(txId).update({ status: 'failed', error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── M-Pesa callback — Safaricom POSTs here ───────────────────────────────────
// IMPORTANT: This route must NOT require auth — Safaricom calls it directly
// Your CALLBACK_BASE_URL must point to your public Lambda URL
router.post('/callback', async (req, res) => {
  // Always respond 200 immediately — Safaricom retries if you don't
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  try {
    const { db, rtdb } = getFirebase();
    const body = req.body?.Body?.stkCallback;
    if (!body) return;

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = body;

    const snap = await db.collection('deposits')
      .where('checkoutRequestId', '==', CheckoutRequestID)
      .limit(1)
      .get();

    if (snap.empty) return;

    const doc = snap.docs[0];
    const deposit = doc.data();

    if (ResultCode === 0) {
      const items = CallbackMetadata?.Item || [];
      const meta = {};
      items.forEach(i => { meta[i.Name] = i.Value; });

      const kesAmount  = meta.Amount || deposit.amount;
      const mpesaCode  = meta.MpesaReceiptNumber;

      // Convert KES to USDT
      const kesPerUsd  = await getKesPerUsd();
      const usdtAmount = parseFloat(kesAmount) / kesPerUsd;

      // Credit user balances atomically
      const userRef = db.collection('users').doc(deposit.uid);
      await db.runTransaction(async tx => {
        const userSnap = await tx.get(userRef);
        const data = userSnap.data();
        const currentKes  = data.balances?.KES  || 0;
        const currentUsdt = data.balances?.USDT || 0;
        tx.update(userRef, {
          'balances.KES':  currentKes  + parseFloat(kesAmount),
          'balances.USDT': currentUsdt + usdtAmount,
        });
      });

      await doc.ref.update({
        status: 'completed',
        mpesaCode,
        amount: kesAmount,
        usdtCredited: usdtAmount,
        kesPerUsd,
        completedAt: Date.now(),
      });

      // Push real-time update to frontend via Firebase RTDB
      await rtdb.ref(`deposits/${deposit.uid}/${doc.id}`).set({
        status: 'completed',
        amount: kesAmount,
        usdtCredited: usdtAmount,
        mpesaCode,
        ts: Date.now(),
      });

    } else {
      await doc.ref.update({ status: 'failed', resultDesc: ResultDesc });
      await rtdb.ref(`deposits/${deposit.uid}/${doc.id}`).set({
        status: 'failed',
        ts: Date.now(),
      });
    }
  } catch (err) {
    console.error('Callback processing error:', err);
    // Response already sent — nothing more to do
  }
});

// ── B2C result callback ───────────────────────────────────────────────────────
router.post('/b2c/result', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  // TODO: handle withdrawal results
});

router.post('/b2c/timeout', async (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// ── Deposit status polling ────────────────────────────────────────────────────
router.get('/status/:txId', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('deposits').doc(req.params.txId).get();
  if (!snap.exists) return res.status(404).json({ error: 'Not found' });
  const d = snap.data();
  if (d.uid !== req.user.uid) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    status:       d.status,
    amount:       d.amount,
    mpesaCode:    d.mpesaCode,
    usdtCredited: d.usdtCredited,
    kesPerUsd:    d.kesPerUsd,
  });
});

module.exports = router;