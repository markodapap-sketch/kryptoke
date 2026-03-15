const axios = require('axios');

const BASE_URL = process.env.MPESA_ENVIRONMENT === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

async function getToken() {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');
  const res = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return res.data.access_token;
}

// ── STK Push — collect KES from user ─────────────────────────────────────────
async function stkPush({ phone, amount, accountRef, description }) {
  let p = phone.toString().replace(/\s/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('+')) p = p.slice(1);

  const timestamp = new Date().toISOString().replace(/[-T:.Z]/g, '').slice(0, 14);
  const password = Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`
  ).toString('base64');

  const token = await getToken();
  const res = await axios.post(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   'CustomerPayBillOnline',
      Amount:            Math.ceil(amount),
      PartyA:            p,
      PartyB:            process.env.MPESA_SHORTCODE,
      PhoneNumber:       p,
      CallBackURL:       `${process.env.CALLBACK_BASE_URL}/api/mpesa/callback`,
      AccountReference:  accountRef || 'KryptoKE Deposit',
      TransactionDesc:   description || 'Crypto Exchange Deposit',
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.data;
}

// ── B2C — send KES to user (withdrawals) ─────────────────────────────────────
// Result/timeout callbacks go to /api/withdraw/b2c/* so the withdraw route
// handles balance refunds and status updates in one place.
async function b2cSend({ phone, amount, remarks }) {
  let p = phone.toString().replace(/\s/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('+')) p = p.slice(1);

  const token = await getToken();
  const res = await axios.post(
    `${BASE_URL}/mpesa/b2c/v1/paymentrequest`,
    {
      InitiatorName:      process.env.INITIATOR_NAME,
      SecurityCredential: process.env.SECURITY_CREDENTIAL,
      CommandID:          'BusinessPayment',
      Amount:             Math.ceil(amount),
      PartyA:             process.env.MPESA_SHORTCODE,
      PartyB:             p,
      Remarks:            remarks || 'KryptoKE Withdrawal',
      QueueTimeOutURL:    `${process.env.CALLBACK_BASE_URL}/api/withdraw/b2c/timeout`,
      ResultURL:          `${process.env.CALLBACK_BASE_URL}/api/withdraw/b2c/result`,
      Occasion:           remarks || 'Withdrawal',
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

module.exports = { stkPush, b2cSend, getToken };