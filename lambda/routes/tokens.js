const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
const { getFirebase } = require('../services/firebase');
const { getTokenInfo, getTokenPrice } = require('../services/bsc');

// Default whitelisted tokens on BSC
const DEFAULT_TOKENS = [
  { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', symbol: 'WBNB', name: 'Wrapped BNB', decimals: 18, isNative: true },
  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', symbol: 'BUSD', name: 'Binance USD', decimals: 18 },
  { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', name: 'Tether USD', decimals: 18 },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', symbol: 'ETH', name: 'Ethereum Token', decimals: 18 },
  { address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', symbol: 'DOT', name: 'Polkadot Token', decimals: 18 },
  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', symbol: 'CAKE', name: 'PancakeSwap Token', decimals: 18 },
];

// List all whitelisted tokens
router.get('/', async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('tokens').get();

  let tokens = [...DEFAULT_TOKENS];
  snap.forEach(doc => {
    const t = doc.data();
    if (!tokens.find(x => x.address.toLowerCase() === t.address.toLowerCase())) {
      tokens.push(t);
    }
  });

  res.json({ tokens });
});

// Get token price + info
router.get('/price/:address', async (req, res) => {
  try {
    const [info, priceData] = await Promise.all([
      getTokenInfo(req.params.address),
      getTokenPrice(req.params.address),
    ]);
    res.json({ ...info, ...priceData });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: whitelist a new token
router.post('/whitelist', authMiddleware, async (req, res) => {
  // TODO: add admin role check
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: 'Token address required' });

  try {
    const [info, priceData] = await Promise.all([
      getTokenInfo(address),
      getTokenPrice(address),
    ]);

    const { db, rtdb } = getFirebase();
    const token = {
      ...info,
      ...priceData,
      whitelistedAt: Date.now(),
      whitelistedBy: req.user.uid,
      isNew: true,
    };

    await db.collection('tokens').doc(address.toLowerCase()).set(token);

    // Notify all connected clients of new token
    await rtdb.ref('newTokens').push({ ...token, ts: Date.now() });

    res.json({ success: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove token from whitelist
router.delete('/whitelist/:address', authMiddleware, async (req, res) => {
  const { db } = getFirebase();
  await db.collection('tokens').doc(req.params.address.toLowerCase()).delete();
  res.json({ success: true });
});

module.exports = router;
