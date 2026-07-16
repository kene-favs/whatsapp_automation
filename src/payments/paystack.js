const axios = require('axios');
const db = require('../db/supabase');

const SECRET = process.env.PAYSTACK_SECRET_KEY;
const PLAN_CODE = process.env.PAYSTACK_PLAN_CODE;
const SETUP_AMOUNT = parseInt(process.env.PAYSTACK_SETUP_AMOUNT || '3000000'); // ₦30,000 in kobo

const api = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: { Authorization: `Bearer ${SECRET}` }
});

// Initialize a one-time setup payment (returns authorization_url)
async function initializeSetupPayment(email, clientId, callbackUrl) {
  const ref = `SETUP-${clientId}-${Date.now()}`;
  const { data } = await api.post('/transaction/initialize', {
    email,
    amount: SETUP_AMOUNT,
    reference: ref,
    callback_url: callbackUrl,
    metadata: { client_id: clientId, payment_type: 'setup' }
  });
  // Record pending payment
  await db.createPayment(clientId, 'setup', SETUP_AMOUNT / 100, 'NGN', 'paystack', ref);
  return { authorization_url: data.data.authorization_url, reference: ref };
}

// Create a Paystack customer
async function createCustomer(email, name, phone) {
  const { data } = await api.post('/customer', { email, first_name: name, phone });
  return data.data; // { customer_code, id, ... }
}

// Subscribe a customer to the monthly plan
async function createSubscription(customerCode, authorizationCode) {
  const { data } = await api.post('/subscription', {
    customer: customerCode,
    plan: PLAN_CODE,
    authorization: authorizationCode
  });
  return data.data; // { subscription_code, email_token, ... }
}

// Verify a transaction by reference
async function verifyTransaction(reference) {
  const { data } = await api.get(`/transaction/verify/${reference}`);
  return data.data; // { status, amount, customer, authorization, ... }
}

// Handle incoming Paystack webhook events
async function handleWebhook(event, payload) {
  switch (event) {
    case 'charge.success': {
      const ref = payload.reference;
      const meta = payload.metadata || {};
      const clientId = meta.client_id;
      const paymentType = meta.payment_type;

      if (paymentType === 'setup' && clientId) {
        // Mark payment success
        await db.updatePaymentStatus(ref, 'success');
        // Mark client as setup paid and activate subscription
        const customer = payload.customer;
        // Create Paystack subscription for monthly billing
        try {
          const sub = await createSubscription(customer.customer_code, payload.authorization.authorization_code);
          await db.updateClient(clientId, {
            setup_paid: true,
            status: 'active',
            paystack_customer_id: customer.customer_code,
            paystack_subscription_code: sub.subscription_code,
            paystack_email_token: sub.email_token,
            subscription_active: true
          });
        } catch (err) {
          // Subscription creation can be done manually later; still activate
          await db.updateClient(clientId, {
            setup_paid: true,
            status: 'active',
            paystack_customer_id: customer.customer_code
          });
        }
      }
      break;
    }

    case 'subscription.create': {
      const subCode = payload.subscription_code;
      const customerCode = payload.customer.customer_code;
      // Find client by paystack_customer_id and ensure subscription is active
      const clients = await db.getAllClients();
      const client = clients.find(c => c.paystack_customer_id === customerCode);
      if (client) {
        await db.updateClient(client.id, {
          paystack_subscription_code: subCode,
          subscription_active: true
        });
      }
      break;
    }

    case 'invoice.payment_failed': {
      const customerCode = payload.customer.customer_code;
      const clients = await db.getAllClients();
      const client = clients.find(c => c.paystack_customer_id === customerCode);
      if (client) {
        await db.updateClient(client.id, { subscription_active: false, status: 'paused' });
      }
      break;
    }

    case 'subscription.disable': {
      const subCode = payload.subscription_code;
      const clients = await db.getAllClients();
      const client = clients.find(c => c.paystack_subscription_code === subCode);
      if (client) {
        await db.updateClient(client.id, { subscription_active: false, status: 'paused' });
      }
      break;
    }
  }
}

module.exports = { initializeSetupPayment, createCustomer, createSubscription, verifyTransaction, handleWebhook };
