# KryptoKE — Developer Documentation

BSC crypto exchange with M-Pesa deposits, wallet connect, and new token whitelisting.
Built on AWS Lambda + Firebase + GitHub Pages.

---

## Current Architecture

```
GitHub Pages
  index.html (frontend — Binance-style UI)
      |
      | REST API
      v
AWS API Gateway → AWS Lambda (dex-exchange-server)
  server.js — Express router
  routes/
    auth.js      — register, login (JWT)
    wallet.js    — balances, deposit address
    trade.js     — quote, build swap tx, confirm
    tokens.js    — whitelist management
    market.js    — chart candles, price feed
    mpesa.js     — STK push deposit + callback
  services/
    bsc.js       — BSC RPC, PancakeSwap V2 price + swap routing
    firebase.js  — Firebase Admin SDK init
    mpesa.js     — M-Pesa Daraja API calls
  middleware/
    auth.js      — JWT verification
      |
      |── Firebase Firestore
      |     users, balances, trades, tokens, deposits
      |── Firebase Realtime DB
      |     live trade feed, deposit status push
      └── BSC RPC (bsc-dataseed1.binance.org)
            PancakeSwap V2 pool reads
```

---

## Current Capabilities

- User registration and login (email + password, JWT auth)
- Custodial wallet generation per user (BSC BEP-20)
- Wallet connect (MetaMask, Trust Wallet)
- M-Pesa STK Push deposits → internal KES balance
- Token price fetch from PancakeSwap V2 pool reserves
- Swap quote and transaction builder (PancakeSwap V2 router)
- Token whitelisting by admin
- Candlestick chart (TradingView Lightweight Charts + The Graph subgraph)
- Real-time trade feed via Firebase Realtime DB
- GitHub Actions CI/CD → Lambda + GitHub Pages

---

## Future Improvements

This section documents planned features. Do not implement until the current
version is live, tested, and stable.

---

### 1. Additional DEX Integrations

**Goal:** Route swaps through whichever DEX offers the best price.

**DEXes to add (all BSC):**
- PancakeSwap V3 — concentrated liquidity, better rates on majors
- BiSwap — lower fees (0.1%), good for stablecoin pairs
- THENA — ve(3,3) model, good for new token launches
- ApeSwap — strong community token support

**How to add a DEX:**
Each DEX has its own Router and Factory contract address. The pattern in `services/bsc.js` is:
1. Add the Router and Factory addresses as constants
2. Add a `getQuote_DEXNAME(tokenIn, tokenOut, amountIn)` function using that router's `getAmountsOut`
3. In `getQuote()`, call all DEX quote functions in parallel with `Promise.allSettled`
4. Return the path from whichever DEX returned the highest `amountOut`

**Files to edit:** `lambda/services/bsc.js`

**Reference contracts:**
- PancakeSwap V3 Router: `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`
- BiSwap Router: `0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8`
- THENA Router: `0xd4ae6eCA985340Dd434D38F470aCCce4DC78d109`

---

### 2. Additional Token Support

**Goal:** Support tokens on chains beyond BSC.

**Chains to add:**
- Ethereum mainnet — larger market, higher fees
- Base — low fees, growing ecosystem, Coinbase-backed
- Solana — fastest chain, most meme coin launches

**How to add a chain:**
1. Add a new RPC URL env var (e.g. `ETH_RPC_URL`, `BASE_RPC_URL`)
2. Create a new service file (e.g. `services/ethereum.js`) mirroring `bsc.js`
3. Update `routes/tokens.js` to accept a `chain` field when whitelisting
4. Update `routes/market.js` to route price requests to the correct chain service
5. Update the frontend to show chain badges on token list items and warn users which network to use for wallet connect

**Files to edit:** `lambda/services/`, `lambda/routes/tokens.js`, `lambda/routes/market.js`, `frontend/index.html`

---

### 3. Additional Payment Methods

**Current:** M-Pesa STK Push (KES deposits only)

**Methods to add:**

**Bank transfer (Pesalink):**
- Integrate via a Kenyan payment processor (e.g. Jenga API by Equity, or DPO Group)
- User initiates transfer, webhook confirms, KES balance credited

**Card payments (Visa/Mastercard):**
- Integrate Flutterwave or Stripe (Stripe is not available in Kenya — use Flutterwave)
- Flutterwave has a Node.js SDK: `npm install flutterwave-node-v3`
- Add `routes/flutterwave.js` following same pattern as `routes/mpesa.js`

**M-Pesa withdrawal (already partially built):**
- `services/mpesa.js` already has B2C setup from the original oda-pap server
- Add a `POST /api/mpesa/withdraw` route that calls B2C
- Minimum withdrawal, daily limits, and KYC check required before enabling

**Airtel Money:**
- Airtel Kenya has a developer API at `developers.airtel.africa`
- Similar STK push flow to M-Pesa

**Files to add:** `lambda/routes/flutterwave.js`, `lambda/routes/withdraw.js`
**Files to edit:** `lambda/server.js` (register new routes), `frontend/index.html` (deposit modal)

---

### 4. Withdrawals

**Goal:** Allow users to withdraw KES or crypto.

**KES withdrawal (M-Pesa B2C):**
1. User requests withdrawal amount + phone number
2. Check KES balance in Firestore is sufficient
3. Deduct balance immediately (optimistic, before B2C call)
4. Call M-Pesa B2C API (already in `services/mpesa.js` from oda-pap)
5. On B2C result callback: if success, mark complete; if fail, refund balance
6. Add daily withdrawal limits per user until KYC is verified

**Crypto withdrawal:**
1. User provides external BSC wallet address + token + amount
2. Verify custodial wallet has sufficient balance on-chain
3. Build a transfer transaction from custodial wallet to user's external address
4. Sign with custodial private key (requires AWS KMS — see Security section)
5. Broadcast to BSC

**Files to add:** `lambda/routes/withdraw.js`
**Files to edit:** `lambda/services/bsc.js` (add `sendFromCustodial()`), `frontend/index.html`

---

### 5. Security Improvements

**These are required before handling significant user funds.**

**AWS KMS for private key encryption:**
- Currently custodial wallet private keys are stored plaintext in Firestore
- Replace with: encrypt private key using AWS KMS before storing, decrypt only inside Lambda when signing
- `npm install @aws-sdk/client-kms`
- Add `services/kms.js` with `encrypt(plaintext)` and `decrypt(ciphertext)` functions
- Update `routes/auth.js` to encrypt on wallet generation
- Update `routes/withdraw.js` (future) to decrypt when signing

**KYC (identity verification):**
- Integrate Smile Identity (African-focused, supports Kenyan ID)
- API: `docs.smileidentity.com`
- Add `routes/kyc.js` with document upload and verification webhook
- Store KYC status in Firestore user record
- Gate withdrawals and large deposits behind `kycStatus === 'verified'`

**Rate limiting:**
- Add `express-rate-limit` to all public routes
- Stricter limits on `/api/auth/login` to prevent brute force
- `npm install express-rate-limit`

**Admin role:**
- Currently `/api/tokens/whitelist` only checks for a valid JWT — any user can whitelist
- Add an `isAdmin` field to Firestore user records
- Add admin check middleware and apply to whitelist, withdrawal approval routes

**Files to add:** `lambda/services/kms.js`, `lambda/routes/kyc.js`, `lambda/middleware/admin.js`
**Files to edit:** `lambda/routes/auth.js`, `lambda/routes/tokens.js`, `lambda/server.js`

---

### 6. Order Book and Limit Orders

**Goal:** Allow users to place limit orders (buy/sell at a specific price).

**How it works:**
- Store open orders in Firestore `orders` collection
- A scheduled Lambda (EventBridge every 30s) checks open orders against current price
- When price condition is met, execute the swap automatically
- This requires custodial wallet signing (see KMS section above)

**Files to add:** `lambda/routes/orders.js`, `lambda/handlers/orderMatcher.js`

---

### 7. Fiat-to-Crypto Conversion

**Goal:** Allow users to use their KES balance to buy crypto directly (not just deposit).

**Current state:** KES balance is tracked in Firestore but not yet connected to swap execution.

**How to implement:**
1. User selects KES as tokenIn in the swap form
2. Backend converts KES → USDT at current rate (using a forex feed or fixed rate)
3. Platform's own BSC wallet holds USDT reserves
4. Platform sends USDT to user's custodial wallet
5. User can then swap USDT → any token

**This requires the platform to maintain a USDT float on BSC.**

---

### 8. New Token Launch Alerts

**Goal:** Notify users when a new token is whitelisted.

**Options:**
- Push notification via Firebase Cloud Messaging (FCM)
- Telegram bot using `node-telegram-bot-api`
- Email via SendGrid

**Auto-detection of new PancakeSwap launches:**
- Subscribe to PancakeSwap Factory `PairCreated` event using ethers.js WebSocket provider
- Filter pairs where one token is WBNB or BUSD and liquidity > $50k
- Queue for admin review rather than auto-whitelisting

---

## Deployment Reference

See the separate deployment guide for step-by-step Lambda and GitHub setup.

**Lambda function name:** `dex-exchange-server`
**S3 bucket:** `oda-pap-lambda-deploy`
**IAM role:** `arn:aws:iam::337909750977:role/oda-pap-lambda-role`
**Region:** `ap-south-1`
**Runtime:** `nodejs22.x`

---

## Environment Variables Reference

| Variable | Where used | Description |
|---|---|---|
| `JWT_SECRET` | Lambda | Signs user auth tokens |
| `FIREBASE_PROJECT_ID` | Lambda | Firebase project |
| `FIREBASE_CLIENT_EMAIL` | Lambda | Service account email |
| `FIREBASE_PRIVATE_KEY` | Lambda | Service account private key |
| `FIREBASE_DATABASE_URL` | Lambda | Realtime DB URL |
| `MPESA_CONSUMER_KEY` | Lambda | Daraja API key |
| `MPESA_CONSUMER_SECRET` | Lambda | Daraja API secret |
| `MPESA_SHORTCODE` | Lambda | Paybill/till number |
| `MPESA_PASSKEY` | Lambda | STK push passkey |
| `CALLBACK_BASE_URL` | Lambda | Your API Gateway URL + /prod |
| `BSC_RPC_URL` | Lambda | BSC JSON-RPC endpoint |
| `LAMBDA_API_URL` | GitHub Secret | Injected into index.html at deploy |
| `FIREBASE_API_KEY` | GitHub Secret | Injected into index.html at deploy |
| `FIREBASE_AUTH_DOMAIN` | GitHub Secret | Injected into index.html at deploy |

---

## Known Limitations (fix before scaling)

1. Custodial private keys stored unencrypted in Firestore — add KMS before real funds
2. No admin role check on token whitelist endpoint — any logged-in user can whitelist
3. BSC RPC uses free public node — add Alchemy/QuickNode for reliability under load
4. No withdrawal route yet — KES deposits credit balance but cannot be withdrawn
5. KES balance not yet connected to swap — users must use external wallet for trades
6. The Graph subgraph may be slow or fail — chart falls back to single price point
