const db = require('../db/supabase');

// Tracks pending payment confirmations
// Key: clientId + ':' + customerJid
const pendingConfirmations = new Map();

const PAYMENT_CLAIM_KEYWORDS = [
  'i have paid', 'i don pay', 'i paid', 'payment done', 'payment sent',
  'i just paid', 'i transferred', 'i sent the money', 'check your account',
  'i don send am', 'i send am', 'na pay i pay', 'transfer done',
  'payment complete', 'i made payment', 'see my receipt', 'i have made payment',
  'money sent', 'i don do transfer', 'alert don drop', 'i don transfer',
  'abeg check', 'check account', 'payment successfull', 'i pay already'
];

function isPaymentClaim(text) {
  const lower = text.toLowerCase();
  return PAYMENT_CLAIM_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

async function notifyOwnerOfPaymentClaim(sock, clientId, customerJid, customerMessage) {
  const client = await db.getClientById(clientId);
  if (!client || !client.notification_number) return;

  const customerNum = customerJid.replace('@s.whatsapp.net', '');
  const ownerJid = client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net';

  const key = clientId + ':' + customerJid;
  pendingConfirmations.set(key, {
    customerJid: customerJid,
    clientId: clientId,
    customerMessage: customerMessage,
    timestamp: Date.now()
  });

  const alertMsg =
    '*PAYMENT ALERT*\n\n' +
    'Customer: +' + customerNum + '\n' +
    'Message: _"' + customerMessage + '"_\n\n' +
    'Reply with a number:\n' +
    '*1* - Payment confirmed\n' +
    '*2* - Ask customer to wait\n' +
    '*3* - Payment not received';

  await sock.sendMessage(ownerJid, { text: alertMsg });
  console.log('[PaymentNotifier] Alerted owner for client ' + clientId);
}

async function handleOwnerReply(sock, fromJid, text, clientId) {
  const client = await db.getClientById(clientId);
  if (!client || !client.notification_number) return false;

  const ownerJid = client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net';
  if (fromJid !== ownerJid) return false;

  const trimmed = text.trim();
  if (!['1', '2', '3'].includes(trimmed)) return false;

  let found = null;
  let foundKey = null;
  for (const [key, val] of pendingConfirmations.entries()) {
    if (val.clientId === clientId) {
      if (!found || val.timestamp > found.timestamp) {
        found = val;
        foundKey = key;
      }
    }
  }

  if (!found) {
    await sock.sendMessage(ownerJid, { text: 'No pending payment confirmation found.' });
    return true;
  }

  const customerJid = found.customerJid;
  const customerNum = customerJid.replace('@s.whatsapp.net', '');

  if (trimmed === '1') {
    await sock.sendMessage(customerJid, {
      text: 'Great news! Your payment has been confirmed. We will process your order shortly. Thank you!'
    });
    await sock.sendMessage(ownerJid, { text: 'Confirmed. Message sent to +' + customerNum });
    pendingConfirmations.delete(foundKey);
  } else if (trimmed === '2') {
    await sock.sendMessage(customerJid, {
      text: 'Thank you for your payment! We are currently verifying it -- please bear with us for a few minutes. We will confirm shortly.'
    });
    await sock.sendMessage(ownerJid, { text: 'Wait message sent to +' + customerNum });
  } else if (trimmed === '3') {
    await sock.sendMessage(customerJid, {
      text: 'Hi! We have not received your payment yet. Please check and resend to our account. Contact us if you need help.'
    });
    await sock.sendMessage(ownerJid, { text: 'Not confirmed message sent to +' + customerNum });
    pendingConfirmations.delete(foundKey);
  }

  return true;
}

async function notifyOwnerHumanRequest(sock, clientId, customerJid) {
  const client = await db.getClientById(clientId);
  if (!client || !client.notification_number) return;

  const customerNum = customerJid.replace('@s.whatsapp.net', '');
  const ownerJid = client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net';

  await sock.sendMessage(ownerJid, {
    text:
      '*CUSTOMER WANTS TO SPEAK WITH YOU*\n\n' +
      '+' + customerNum + ' is asking to talk to a real person.\n\n' +
      'Open your WhatsApp and search for +' + customerNum + ' to reply directly.\n\n' +
      '_The bot has been paused for this customer for 30 minutes._'
  });
}

module.exports = {
  isPaymentClaim,
  notifyOwnerOfPaymentClaim,
  handleOwnerReply,
  notifyOwnerHumanRequest,
  pendingConfirmations
};
