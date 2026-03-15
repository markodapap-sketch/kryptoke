const express = require('express');
const serverless = require('serverless-http');
const cors = require('cors');

const authRoutes   = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const tradeRoutes  = require('./routes/trade');
const mpesaRoutes  = require('./routes/mpesa');
const tokenRoutes  = require('./routes/tokens');
const marketRoutes = require('./routes/market');
const sweepRoutes    = require('./routes/sweep');
const withdrawRoutes = require('./routes/withdraw');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Sweep-Secret'],
}));

app.options('*', cors());
app.use(express.json());

// Strip /prod prefix when running on Lambda
app.use((req, res, next) => {
  if (req.path.startsWith('/prod')) {
    req.url = req.url.replace('/prod', '') || '/';
  }
  next();
});

app.use('/api/auth',   authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/trade',  tradeRoutes);
app.use('/api/mpesa',  mpesaRoutes);
app.use('/api/tokens', tokenRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/sweep',    sweepRoutes);
app.use('/api/withdraw', withdrawRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'local',
    ts: Date.now(),
  });
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  module.exports.handler = serverless(app);
} else {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`KryptoKE server running on http://localhost:${PORT}`));
}