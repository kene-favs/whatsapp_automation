const Stripe = require('stripe');
const db = require('../db/supabase');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SETUP_PRICE_ID = process.env.STRIPE_SETUP_PRICE_ID;
const MONTHLY_PRICE_ID = process.env.STRIPE_MONTHLY_PRICE_ID;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Create a Stripe customer
async function createCustomer(email, name) {
  const customer = await stripe.customers.create({ email, name });
  return customer;
}

// Create a Checkout Session for the $45 setup fee (one-time + subscription)
async function createCheckoutSession(email, name, clientId, successUrl, cancelUrl) {
  // Create/find customer
  const customer = await createCustomer(email, name);

  const session = await stripe.checkout.sessions.create({
    customer: customer.id,
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: [{ price: SETUP_PRICE_ID, quantity: 1 }],
    success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: cancelUrl,
    metadata: { client_id: clientId, payment_type: 'setup', customer_id: customer.id }
  });

  // Record pending payment
  await db.createPayment(clientId, 'setup', 45, 'USD', 'stripe', session.id);

  return { url: session.url, session_id: session.id, customer_id: customer.id };
}

// After setup payment succeeds, create the monthly subscription
async function createSubscription(customerId, clientId) {
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: MONTHLY_PRICE_ID }],
    metadata: { client_id: clientId }
  });
  return sub;
}

// Construct and verify webhook event from raw body + signature
function constructWebhookEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

// Handle Stripe webhook events
async function handleWebhook(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const clientId = session.metadata?.client_id;
      const customerId = session.metadata?.customer_id || session.customer;
      const paymentType = session.metadata?.payment_type;

      if (paymentType === 'setup' && clientId) {
        await db.updatePaymentStatus(session.id, 'success');

        // Create monthly subscription
        let subId = null;
        try {
          const sub = await createSubscription(customerId, clientId);
          subId = sub.id;
        } catch (e) {
          console.error('Stripe subscription error:', e.message);
        }

        await db.updateClient(clientId, {
          setup_paid: true,
          status: 'active',
          stripe_customer_id: customerId,
          stripe_subscription_id: subId,
          subscription_active: true
        });
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const inv = event.data.object;
      const customerId = inv.customer;
      const clients = await db.getAllClients();
      const client = clients.find(c => c.stripe_customer_id === customerId);
      if (client) {
        await db.updateClient(client.id, { subscription_active: true, status: 'active' });
        await db.createPayment(client.id, 'subscription', inv.amount_paid / 100, 'USD', 'stripe', inv.id);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object;
      const customerId = inv.customer;
      const clients = await db.getAllClients();
      const client = clients.find(c => c.stripe_customer_id === customerId);
      if (client) {
        await db.updateClient(client.id, { subscription_active: false, status: 'paused' });
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const clients = await db.getAllClients();
      const client = clients.find(c => c.stripe_subscription_id === sub.id);
      if (client) {
        await db.updateClient(client.id, { subscription_active: false, status: 'cancelled' });
      }
      break;
    }
  }
}

module.exports = { createCustomer, createCheckoutSession, createSubscription, constructWebhookEvent, handleWebhook };
