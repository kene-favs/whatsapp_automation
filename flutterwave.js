const axios = require('axios');

const FLW_SECRET = process.env.FLW_SECRET_KEY;
const FLW_HASH = process.env.FLW_HASH;
const FLW_PLAN_ID = process.env.FLW_MONTHLY_PLAN_ID;
const FLW_SETUP_AMOUNT = process.env.FLW_SETUP_AMOUNT || 30000;

// ── Initialize Nigerian payment (one-time setup fee) ──────────────────────────
async function initializeSetupPayment(email, clientId, redirectUrl) {
  const txRef = 'forge_setup_' + clientId + '_' + Date.now();

  const response = await axios.post(
    'https://api.flutterwave.com/v3/payments',
    {
      tx_ref: txRef,
      amount: FLW_SETUP_AMOUNT,
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email: email },
      payment_options: 'card,banktransfer,ussd,opay,palmpay',
      meta: { clientId: clientId, paymentType: 'setup' },
      customizations: {
        title: 'ForgeBot Setup',
        description: 'One-time WhatsApp bot setup — ForgeBot by TheFavsForge',
        logo: ''
      }
    },
    {
      headers: { Authorization: 'Bearer ' + FLW_SECRET, 'Content-Type': 'application/json' }
    }
  );

  return {
    authorization_url: response.data.data.link,
    reference: txRef
  };
}

// ── Verify a transaction server-side after redirect ────────────────────────────
async function verifyTransaction(transactionId) {
  const response = await axios.get(
    'https://api.flutterwave.com/v3/transactions/' + transactionId + '/verify',
    { headers: { Authorization: 'Bearer ' + FLW_SECRET } }
  );
  return response.data.data;
}

// ── Enroll client in monthly ₦10,000 plan ────────────────────────────────────
async function createSubscription(email, clientId) {
  if (!FLW_PLAN_ID) {
    console.warn('[Flutterwave] No FLW_MONTHLY_PLAN_ID set — skipping subscription');
    return null;
  }
  try {
    const response = await axios.post(
      'https://api.flutterwave.com/v3/payment-plans/' + FLW_PLAN_ID + '/subscriptions',
      { email: email },
      { headers: { Authorization: 'Bearer ' + FLW_SECRET } }
    );
    return response.data.data;
  } catch (err) {
    console.error('[Flutterwave] Subscription creation failed:', err.message);
    return null;
  }
}

// ── Verify webhook hash ───────────────────────────────────────────────────────
function verifyWebhookHash(reqHash) {
  return reqHash === FLW_HASH;
}

module.exports = {
  initializeSetupPayment,
  verifyTransaction,
  createSubscription,
  verifyWebhookHash
};
