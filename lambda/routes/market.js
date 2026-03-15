const router = require('express').Router();
const { getFirebase } = require('../services/firebase');
const { getTokenPrice, getBNBPrice } = require('../services/bsc');
const { getKesPerUsd } = require('../services/forex');
const axios = require('axios');

const COINGECKO_IDS = {
  '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c': 'binancecoin',
  '0x55d398326f99059fF775485246999027B3197955': 'tether',
  '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56': 'binance-usd',
  '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': 'usd-coin',
  '0x2170Ed0880ac9A755fd29B2688956BD959F933F8': 'ethereum',
  '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82': 'pancakeswap-token',
  '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402': 'polkadot',
};

// ── CoinGecko price (USD) for known tokens ────────────────────────────────────
async function getCoinGeckoPrice(tokenAddress) {
  const id = COINGECKO_IDS[tokenAddress];
  if (!id) return null;
  try {
    const r = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`,
      { timeout: 5000 }
    );
    const data = r.data?.[id];
    if (!data) return null;
    return { price: data.usd, change24h: data.usd_24h_change };
  } catch {
    return null;
  }
}

// ── Aggregated price: CoinGecko + on-chain DEX pools ─────────────────────────
async function getAggregatedPrice(tokenAddress) {
  const [cgData, onChain, kesPerUsd] = await Promise.all([
    getCoinGeckoPrice(tokenAddress),
    getTokenPrice(tokenAddress),
    getKesPerUsd(),
  ]);

  // Prefer CoinGecko for known majors, on-chain for others
  const price    = cgData?.price    || onChain.price    || 0;
  const change24 = cgData?.change24h ?? null;

  return {
    price,
    priceKes:   price * kesPerUsd,
    kesPerUsd,
    liquidity:  onChain.liquidity  || 0,
    change24h:  change24,
    sources: {
      coingecko:    !!cgData,
      pancakeswapV2: onChain.sources > 0,
      biswap:        onChain.sources > 1,
    },
  };
}

// ── Candles from The Graph subgraph ──────────────────────────────────────────
router.get('/candles/:tokenAddress', async (req, res) => {
  const { tokenAddress } = req.params;
  const { interval = 'hour', limit = 48 } = req.query;

  const field     = interval === 'day' ? 'tokenDayDatas' : 'tokenHourDatas';
  const timeField = interval === 'day' ? 'date' : 'periodStartUnix';

  const query = `{
    ${field}(
      where: { token: "${tokenAddress.toLowerCase()}" }
      orderBy: ${timeField}
      orderDirection: desc
      first: ${Math.min(parseInt(limit), 200)}
    ) { ${timeField} open high low close volume priceUSD }
  }`;

  try {
    const r = await axios.post(
      'https://api.thegraph.com/subgraphs/name/pancakeswap/exchange-v2',
      { query },
      { timeout: 8000 }
    );
    const data = r.data?.data?.[field] || [];
    const candles = data.reverse().map(c => ({
      time:   c[timeField],
      open:   parseFloat(c.open   || c.priceUSD),
      high:   parseFloat(c.high   || c.priceUSD),
      low:    parseFloat(c.low    || c.priceUSD),
      close:  parseFloat(c.close  || c.priceUSD),
      volume: parseFloat(c.volume),
    }));
    res.json({ candles, interval });
  } catch {
    const priceData = await getAggregatedPrice(tokenAddress);
    const now = Math.floor(Date.now() / 1000);
    res.json({
      candles: [{ time: now, open: priceData.price, high: priceData.price, low: priceData.price, close: priceData.price, volume: 0 }],
      interval, fallback: true,
    });
  }
});

// ── Live price (aggregated) ───────────────────────────────────────────────────
router.get('/price/:tokenAddress', async (req, res) => {
  try {
    const data = await getAggregatedPrice(req.params.tokenAddress);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── USDT/KES pair — special synthetic pair ────────────────────────────────────
router.get('/usdt-kes', async (req, res) => {
  try {
    const [kesPerUsd, bnbUsd] = await Promise.all([getKesPerUsd(), getBNBPrice()]);
    res.json({
      pair: 'USDT/KES',
      price: kesPerUsd,         // 1 USDT = X KES
      bnbUsd,
      bnbKes: bnbUsd * kesPerUsd,
      updatedAt: Date.now(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Live trades for a token ───────────────────────────────────────────────────
router.get('/trades/:tokenAddress', async (req, res) => {
  const { rtdb } = getFirebase();
  const snap = await rtdb.ref(`trades/${req.params.tokenAddress}`)
    .orderByKey().limitToLast(50).get();
  const trades = [];
  snap.forEach(child => trades.push({ id: child.key, ...child.val() }));
  res.json({ trades: trades.reverse() });
});

// ── Market overview — all tokens with aggregated price ────────────────────────
router.get('/overview', async (req, res) => {
  const { db } = getFirebase();
  const snap = await db.collection('tokens').get();
  const tokens = [];
  snap.forEach(d => tokens.push(d.data()));

  const prices = await Promise.allSettled(
    tokens.map(t => getAggregatedPrice(t.address))
  );

  const result = tokens.map((t, i) => ({
    ...t,
    ...(prices[i].status === 'fulfilled' ? prices[i].value : { price: 0, priceKes: 0 }),
  }));

  res.json({ tokens: result });
});

module.exports = router;