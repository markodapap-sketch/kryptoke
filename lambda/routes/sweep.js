const router = require('express').Router();
const { getFirebase } = require('../services/firebase');
const { sweepUserFunds, getWalletBalance } = require('../services/bsc');
const { USDT } = require('../services/bsc');

const SWEEP_SECRET = process.env.SWEEP_SECRET || 'sweep-secret-change-me';
const HOT_WALLET   = process.env.HOT_WALLET;
const MIN_USDT_TO_SWEEP = parseFloat(process.env.MIN_USDT_TO_SWEEP || '5');

// ── Middleware: only the sweep job can call this ──────────────────────────────
function sweepAuth(req, res, next) {
  const secret = req.headers['x-sweep-secret'];
  if (secret !== SWEEP_SECRET) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Trigger sweep for all users with pending on-chain balance ─────────────────
// Called by EventBridge at 02:00 UTC daily, or manually
router.post('/run', sweepAuth, async (req, res) => {
  const { db } = getFirebase();
  const results = [];

  // Get all users who have an hdIndex (new HD system)
  const snap = await db.collection('users').where('hdIndex', '>=', 0).get();

  const sweepPromises = snap.docs.map(async doc => {
    const user = doc.data();
    try {
      // Check USDT balance on-chain before spending gas
      const usdtBal = parseFloat(await getWalletBalance(user.depositAddress, USDT));
      if (usdtBal < MIN_USDT_TO_SWEEP) return;

      const txs = await sweepUserFunds({
        hdIndex:      user.hdIndex,
        tokenAddress: USDT,
        minUsdValue:  MIN_USDT_TO_SWEEP,
      });

      if (txs.length > 0) {
        // Credit internal USDT balance and mark swept
        const userRef = db.collection('users').doc(user.uid);
        await db.runTransaction(async tx => {
          const snap = await tx.get(userRef);
          const current = snap.data().balances?.USDT || 0;
          tx.update(userRef, { 'balances.USDT': current + usdtBal });
        });

        await db.collection('sweeps').add({
          uid:      user.uid,
          address:  user.depositAddress,
          hdIndex:  user.hdIndex,
          amount:   usdtBal,
          txHashes: txs.map(t => t.txHash),
          ts:       Date.now(),
        });

        results.push({ uid: user.uid, amount: usdtBal, txs });
      }
    } catch (e) {
      results.push({ uid: user.uid, error: e.message });
    }
  });

  await Promise.allSettled(sweepPromises);
  res.json({ swept: results.length, results });
});

// ── Status: see sweep history ─────────────────────────────────────────────────
router.get('/history', sweepAuth, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('sweeps').orderBy('ts', 'desc').limit(50).get();
  const history = [];
  snap.forEach(d => history.push(d.data()));
  res.json({ history });
});

module.exports = router;