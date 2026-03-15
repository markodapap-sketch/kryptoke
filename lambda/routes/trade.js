const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { getFirebase } = require('../services/firebase');
const { getQuote, buildSwapTx, getTokenInfo } = require('../services/bsc');
const { v4: uuidv4 } = require('uuid');

// Get a quote for a swap
router.post('/quote', async (req, res) => {
  const { tokenIn, tokenOut, amountIn, decimalsIn } = req.body;
  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: 'tokenIn, tokenOut, amountIn required' });
  }
  try {
    const quote = await getQuote(tokenIn, tokenOut, amountIn, decimalsIn || 18);
    res.json(quote);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Build swap transaction (for wallet connect — user signs in browser)
router.post('/build', authMiddleware, async (req, res) => {
  const { tokenIn, tokenOut, amountIn, decimalsIn, slippage, walletAddress } = req.body;
  if (!tokenIn || !tokenOut || !amountIn || !walletAddress) {
    return res.status(400).json({ error: 'tokenIn, tokenOut, amountIn, walletAddress required' });
  }
  try {
    const tx = await buildSwapTx({
      tokenIn,
      tokenOut,
      amountIn,
      decimalsIn: decimalsIn || 18,
      slippage: slippage || 0.5,
      userAddress: walletAddress,
    });

    // Log the trade attempt
    const { db } = getFirebase();
    const tradeId = uuidv4();
    await db.collection('trades').doc(tradeId).set({
      tradeId,
      uid: req.user.uid,
      tokenIn,
      tokenOut,
      amountIn,
      estimatedOut: tx.amountOut,
      status: 'built',
      type: 'wallet_connect',
      createdAt: Date.now(),
    });

    res.json({ ...tx, tradeId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Record confirmed trade (after user signs and broadcasts)
router.post('/confirm', authMiddleware, async (req, res) => {
  const { tradeId, txHash, amountOut } = req.body;
  const { db, rtdb } = getFirebase();

  const ref = db.collection('trades').doc(tradeId);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Trade not found' });

  await ref.update({
    status: 'confirmed',
    txHash,
    amountOut,
    confirmedAt: Date.now(),
  });

  const trade = { ...snap.data(), txHash, amountOut, status: 'confirmed' };

  // Push to realtime DB for chart + feed
  await rtdb.ref(`trades/${trade.tokenOut}`).push({
    price: parseFloat(amountOut) / parseFloat(trade.amountIn),
    amountIn: trade.amountIn,
    amountOut,
    ts: Date.now(),
  });

  res.json({ success: true, trade });
});

// Trade history for current user
router.get('/history', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('trades')
    .where('uid', '==', req.user.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  const trades = [];
  snap.forEach(d => trades.push(d.data()));
  res.json({ trades });
});

module.exports = router;
