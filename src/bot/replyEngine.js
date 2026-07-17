const db = require('../db/supabase');
const { matchKeyword } = require('./keywords');
const { transcribeVoiceNote } = require('./voiceHandler');
const { isPaymentClaim, notifyOwnerHumanRequest } = require('./paymentNotifier');

// Tracks customers paused for human handoff: key = clientId:jid, value = timestamp until paused
const humanPaused = new Map();

// Tracks payment receipt stage per customer
// key: "clientId:customerJid" → { stage, customerJid, clientId }
// stage: 'AWAITING_RECEIPT' | 'PAYMENT_PENDING'
const pendingPayments = new Map();

function humanDelay() {
  return new Promise(function(r) { setTimeout(r, 1500 + Math.random() * 2000); });
}

const HUMAN_HANDOFF_KEYWORDS = [
  'speak to human', 'talk to human', 'real person', 'speak to someone',
  'talk to agent', 'connect me', 'i want to talk', 'speak to owner',
  'talk to owner', 'human please', 'abeg connect me', 'give me human',
  'i want owner', 'customer service', 'customer care', 'live agent',
  'actual person', 'not bot', 'no bot', 'human being'
];

// Triggered when customer asks for account/payment details BEFORE paying
// Bot will send account number + how to pay
const ACCOUNT_REQUEST_KEYWORDS = [
  'account number', 'account details', 'account no', 'acct number',
  'how do i pay', 'how to pay', 'how can i pay', 'payment details',
  'send me your account', 'your account', 'where do i pay', 'what account',
  'bank details', 'bank account', 'send account', 'give me account',
  'your bank', 'pay to where', 'where to pay', 'transfer to where',
  'which account', 'which bank', 'how to transfer', 'transfer details'
];

// Triggered when customer claims they have already paid
// Bot should ONLY ask for receipt — do NOT re-send account details
const PAYMENT_CLAIM_EXTRAS = [
  'i want to order', 'i want to buy', 'let me buy', 'i want to purchase',
  'abeg i wan order', 'i don order', 'let me pay now', 'ready to pay'
];

function wantsHuman(text) {
  const lower = text.toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

function wantsAccountDetails(text) {
  const lower = text.toLowerCase();
  return ACCOUNT_REQUEST_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

function buildAccountMessage(client) {
  if (!client.bank_name || !client.account_number) {
    return '📸 Please contact us directly to get payment details.';
  }
  return '🏦 *Payment Details:*\n' +
    'Bank: ' + client.bank_name + '\n' +
    'Account: ' + client.account_number + '\n' +
    'Name: ' + (client.account_name || client.business_name) + '\n\n' +
    'After payment, please send your *receipt or screenshot* here so we can confirm quickly! 📸';
}

async function handleMessage(sock, msg, clientId) {
  try {
    const jid = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    const msgContent = msg.message;
    const isVoice = !!(msgContent && msgContent.audioMessage && msgContent.audioMessage.ptt);
    const isAudio = !!(msgContent && msgContent.audioMessage);
    const imageMsg = (msgContent && msgContent.imageMessage) ? msgContent.imageMessage : null;

    let text = (msgContent && msgContent.conversation) ||
               (msgContent && msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent && msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    // ── Get client (needed for all checks below) ────────────────────────────
    const client = await db.getClientById(clientId);
    if (!client || client.status !== 'active' || !client.subscription_active) return;

    const ownerJid = String(client.notification_number || '').replace(/\D/g, '') + '@s.whatsapp.net';
    const payKey   = clientId + ':' + jid;

    // ── OWNER REPLY HANDLER: 1 / 2 / 3 from owner's personal number ─────────
    if (jid === ownerJid) {
      const reply = text.trim();
      if (['1', '2', '3'].includes(reply)) {
        // Find the pending customer for this client
        for (var entry of pendingPayments.entries()) {
          var key   = entry[0];
          var state = entry[1];
          if (state.clientId === clientId && state.stage === 'PAYMENT_PENDING') {
            var custJid = state.customerJid;
            if (reply === '1') {
              await sock.sendMessage(custJid, {
                text: '🎉 Great news! Your payment has been confirmed by ' + client.business_name + '!\n\nYour order is now being processed and will be ready soon. Thank you for your patronage! 🛍️'
              });
              pendingPayments.delete(key);
            } else if (reply === '2') {
              await sock.sendMessage(custJid, {
                text: '⏳ We are still verifying your payment. Please give us a few more minutes — we will update you shortly!'
              });
            } else if (reply === '3') {
              await sock.sendMessage(custJid, {
                text: '❌ We could not find your payment yet. Please double-check and resend your *receipt or screenshot* here so we can confirm. 📸'
              });
              pendingPayments.set(key, Object.assign({}, state, { stage: 'AWAITING_RECEIPT' }));
            }
            break;
          }
        }
      }
      return; // Never process owner number as a customer
    }

    // ── Voice note handling ─────────────────────────────────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      const transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(jid, {
          text: 'I received your voice note! Could you please type your message so I can help you faster?'
        });
        return;
      }
      text = transcribed;
      await sock.sendMessage(jid, {
        text: 'I heard: _"' + transcribed + '"_\n\nLet me help you with that...'
      });
    }

    // ── AWAITING_RECEIPT: customer sends an image ────────────────────────────
    var payState = pendingPayments.get(payKey);
    if (payState && payState.stage === 'AWAITING_RECEIPT' && imageMsg) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();

      // Tell customer to wait
      await sock.sendMessage(jid, {
        text: '✅ Receipt received! ⏳\n\nPlease hold on while the owner confirms your payment. We will notify you right away!'
      });

      // Upgrade state
      pendingPayments.set(payKey, Object.assign({}, payState, { stage: 'PAYMENT_PENDING' }));

      // Alert owner with the forwarded receipt image
      var alertText =
        '💰 *Payment Alert — ' + client.business_name + '*\n\n' +
        'A customer sent a payment receipt and is waiting for confirmation.\n' +
        '📱 Customer: ' + jid.replace('@s.whatsapp.net', '') + '\n\n' +
        'Receipt forwarded below 👇\n\n' +
        'Reply with:\n' +
        '*1* — ✅ Confirm payment\n' +
        '*2* — ⏳ Still checking\n' +
        '*3* — ❌ Not found / Decline';

      await sock.sendMessage(ownerJid, { text: alertText });
      await sock.sendMessage(ownerJid, {
        image: imageMsg,
        caption: 'Receipt from ' + jid.replace('@s.whatsapp.net', '')
      });
      return;
    }

    if (!text.trim()) return;

    // ── Check if customer is paused (owner is handling them manually) ────────
    var pauseKey    = clientId + ':' + jid;
    var pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) return;
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff detection ─────────────────────────────────────────────
    if (wantsHuman(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Got it! I am connecting you with the owner right now. Please hold on — they will be with you shortly. 🙏'
      });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000); // pause 30 minutes
      await notifyOwnerHumanRequest(sock, clientId, jid);
      return;
    }

    // ── ACCOUNT DETAILS REQUEST: customer asks how/where to pay ─────────────
    // This is the right time to send account number — BEFORE they pay
    if (wantsAccountDetails(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, { text: buildAccountMessage(client) });
      return;
    }

    // ── PAYMENT CLAIM: customer says "I paid" / "I don send" ────────────────
    // At this point they have already paid — do NOT resend account details
    // Just ask for receipt proof so we can confirm
    if (isPaymentClaim(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Thank you! 🙏\n\nPlease send your *payment receipt or screenshot* here as proof so the owner can confirm your payment faster. 📸'
      });
      // Set state: waiting for receipt image
      pendingPayments.set(payKey, {
        stage:       'AWAITING_RECEIPT',
        clientId:    clientId,
        customerJid: jid,
        timestamp:   Date.now()
      });
      return;
    }

    // ── Flow keyword matching ───────────────────────────────────────────────
    var flows = await db.getFlows(clientId, true);
    var matched = null;
    for (var i = 0; i < flows.length; i++) {
      var flow = flows[i];
      var kws = flow.keywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
      var textLower = text.toLowerCase();
      if (kws.some(function(kw) { return textLower.includes(kw); })) {
        matched = flow;
        break;
      }
    }

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    if (matched) {
      // If the matched response is about price/ordering, auto-append account details
      var responseText = matched.response || '';
      var lowerResponse = responseText.toLowerCase();
      var isOrderResponse = lowerResponse.includes('order') || lowerResponse.includes('pay') ||
                            lowerResponse.includes('₦') || lowerResponse.includes('naira') ||
                            lowerResponse.includes('price') || lowerResponse.includes('cost');

      if (matched.response_type === 'image' && matched.media_url) {
        var caption = matched.response;
        if (isOrderResponse && client.bank_name && client.account_number) {
          caption += '\n\n' + buildAccountMessage(client);
        }
        await sock.sendMessage(jid, { image: { url: matched.media_url }, caption: caption });
      } else {
        var reply = matched.response;
        if (isOrderResponse && client.bank_name && client.account_number) {
          reply += '\n\n' + buildAccountMessage(client);
        }
        await sock.sendMessage(jid, { text: reply });
      }
    } else {
      var fallback = client.fallback_message ||
        'Thank you for reaching out! Someone will get back to you shortly.';
      await sock.sendMessage(jid, { text: fallback });
    }

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
