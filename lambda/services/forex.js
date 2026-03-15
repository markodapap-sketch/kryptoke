const axios = require('axios');

let cached = { rate: 129, ts: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 min

async function getKesPerUsd() {
  if (Date.now() - cached.ts < CACHE_MS) return cached.rate;

  const sources = [
    fetchFromExchangeRate,
    fetchFromFrankfurter,
  ];

  for (const fn of sources) {
    try {
      const rate = await fn();
      if (rate && rate > 50 && rate < 300) {
        cached = { rate, ts: Date.now() };
        return rate;
      }
    } catch {}
  }

  // Return last cached or fallback
  return cached.rate;
}

async function fetchFromExchangeRate() {
  const key = process.env.EXCHANGE_RATE_API_KEY;
  const url = key
    ? `https://v6.exchangerate-api.com/v6/${key}/latest/USD`
    : `https://open.er-api.com/v6/latest/USD`;
  const r = await axios.get(url, { timeout: 5000 });
  return r.data?.rates?.KES;
}

async function fetchFromFrankfurter() {
  const r = await axios.get('https://api.frankfurter.app/latest?from=USD&to=KES', { timeout: 5000 });
  return r.data?.rates?.KES;
}

module.exports = { getKesPerUsd };