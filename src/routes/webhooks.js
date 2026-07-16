const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../db/supabase');
const flutterwave = require('../payments/flutterwave');
const stripe = require('../payments/stripe');
const sessionManager = require('../sessions/sessionManager');

// ─────────────────────────────────────────────────────────────────────────────
// FLUTTERWAVE — Redirect callback (after customer pays on Flutterwave page)
// Flutterwave redirects here with: ?status=successful&tx_ref=xxx&transaction_id=123
// ─────────────────────────────────────────────────────────────────────────────
router.get('/api/webhooks/flutterwave/callback', async (req, res) => {
  const status = req.query.status;
  const txRef = req.query.tx_ref;
  const transactionId = req.query.transaction_id;

  if (status !== 'successful') {
    console.log('[FLW Callback] Payment not successful:', status);
    return res.redirect('/?payment=failed');
  }

  try {
    // Verify server-side (never trust just the redirect params)
    const txData = await flutterwave.verifyTransaction(transactionId);

    if (txData.status !== 'successful') {
      return res.redirect('/?payment=failed');
    }

    const clientId = txData.meta && txData.meta.clientId;
    if (!clientId) {
      console.error('[FLW Callback] No clientId in meta');
      return res.redirect('/?payment=error');
    }

    // Activate the client
    await db.updatePaymentStatus(txRef, 'success').catch(function() {});
    await db.updateClient(clientId, {
      setup_paid: true,
      status: 'active',
      subscription_active: true
    });

    // Enroll in monthly plan
    const email = txData.customer && txData.customer.email;
    if (email) await flutterwave.createSubscription(email, clientId);

    // Auto-start WhatsApp session after 2 seconds
    setTimeout(function() {
      sessionManager.startSession(clientId, {});
    }, 2000);

    // Generate JWT and redirect to QR onboarding page
    const token = jwt.sign({ clientId: clientId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    return res.redirect('/onboard?token=' + token);

  } catch (err) {
    console.error('[FLW Callback] Error:', err.message);
    return res.redirect('/?payment=error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FLUTTERWAVE — Webhook (for subscription events like cancellation)
// Set this URL in your Flutterwave dashboard: https://yourdomain.com/api/webhooks/flutterwave
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/webhooks/flutterwave', express.json(), async (req, res) => {
  const hash = req.headers['verif-hash'];

  if (!flutterwave.verifyWebhookHash(hash)) {
    console.warn('[FLW Webhook] Invalid hash — rejected');
    return res.status(401).send('Invalid hash');
  }

  const event = req.body.event;
  const data = req.body.data;

  try {
    if (event === 'subscription.cancelled' && data) {
      const email = data.customer && data.customer.email;
      if (email) {
        const client = await db.getClientByEmail(email);
        if (client) {
          await db.updateClient(client.id, { subscription_active: false });
          console.log('[FLW Webhook] Subscription cancelled for client:', client.id);
        }
      }
    }

    if (event === 'subscription.activated' && data) {
      const email = data.customer && data.customer.email;
      if (email) {
        const client = await db.getClientByEmail(email);
        if (client) {
          await db.updateClient(client.id, { subscription_active: true });
        }
      }
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('[FLW Webhook] Error:', err.message);
    res.status(500).send('error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE — Webhook (international payments)
// Set this URL in Stripe: https://yourdomain.com/api/webhooks/stripe
// ─────────────────────────────────────────────────────────────────────────────
router.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.constructWebhookEvent(req.body, sig);
  } catch (err) {
    console.error('[Stripe Webhook] Signature error:', err.message);
    return res.status(400).send('Webhook signature failed');
  }

  try {
    await stripe.handleWebhook(event, db, sessionManager);
    res.status(200).send('ok');
  } catch (err) {
    console.error('[Stripe Webhook] Handler error:', err.message);
    res.status(500).send('error');
  }
});

module.exports = router;
