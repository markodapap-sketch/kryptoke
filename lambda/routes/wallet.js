const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { getFirebase } = require('../services/firebase');
const { getWalletBalance, getBNBPrice } = require('../services/bsc');
const { getKesPerUsd } = require('../services/forex');

// ── Wallet info + balances ────────────────────────────────────────────────────
router.get('/info', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('users').doc(req.user.uid).get();
  if (!snap.exists) return res.status(404).json({ error: 'User not found' });

  const user = snap.data();
  const address = user.depositAddress;

  let bnbBalance = '0';
  try { bnbBalance = await getWalletBalance(address, 'BNB'); } catch {}

  res.json({
    depositAddress: address,
    bnbBalance,
    kesBalance:  user.balances?.KES  || 0,
    usdtBalance: user.balances?.USDT || 0,
    kycStatus:   user.kycStatus,
  });
});

// ── Token balance for deposit address ────────────────────────────────────────
router.get('/balance/:tokenAddress', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('users').doc(req.user.uid).get();
  const user = snap.data();

  try {
    const balance = await getWalletBalance(user.depositAddress, req.params.tokenAddress);
    res.json({ balance, address: user.depositAddress });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Live KES/USD rate + derived rates ────────────────────────────────────────
router.get('/rate', async (req, res) => {
  try {
    const [bnbUsd, kesPerUsd] = await Promise.all([getBNBPrice(), getKesPerUsd()]);
    res.json({
      bnbUsd,
      kesPerUsd,
      bnbKes: bnbUsd * kesPerUsd,
      usdtKes: kesPerUsd,        // 1 USDT ≈ 1 USD
      updatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;