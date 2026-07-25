// ============================================================
//  ForgeBot — Payment Notifier v3
//  src/bot/paymentNotifier.js
//
//  v3 changes:
//   - Asks customer for receipt photo BEFORE notifying owner
//   - handleReceiptImage: forwards image to owner with 1/2/3 prompt
//   - Real push notifications on payment events
//   - Receipt URL stored so dashboard can display it
// ============================================================
'use strict';

const { createClient } = require('@supabase/supabase-js');

// ── Lazy Supabase ─────────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

// ── Lazy webpush ──────────────────────────────────────────────
let _webpush = null;
function getWebPush() {
  if (!_webpush) {
    try {
      _webpush = require('web-push');
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        _webpush.setVapidDetails(
          'mailto:support@thefavsforge.com',
          process.env.VAPID_PUBLIC_KEY,
          process.env.VAPID_PRIVATE_KEY
        );
      }
    } catch(e) { _webpush = null; }
  }
  return _webpush;
}

// ── State maps ────────────────────────────────────────────────
//  key: clientId + ':' + customerJid → { ownerJid, customerName, originalMessage, ts }
var pendingReceiptRequests = new Map();

//  key: ownerJid + ':' + clientId → { customerJid, receiptUrl, ts }
var pendingConfirmations = new Map();

// ── Payment keywords ──────────────────────────────────────────
var PAYMENT_CLAIM_KEYWORDS = [
  'i have paid', 'i don pay', 'i paid', 'payment done', 'i\'ve paid',
  'don send money', 'just sent', 'i just transferred', 'i transferred',
  'transfer done', 'transaction done', 'sent payment', 'payment sent',
  'i don transfer', 'payment complete', 'i don pay o', 'see alert',
  'i see the alert', 'alert sent', 'money sent', 'check your account',
  'pay don go', 'i pay am', 'i send am', 'payment confirmed', 'paid already',
  'just paid', 'done with payment', 'i just paid'
];

// ══════════════════════════════════════════════════════════════
//  Push Notification Helper
// ══════════════════════════════════════════════════════════════
async function sendPushToClient(clientId, title, body, url) {
  var wp = getWebPush();
  if (!wp) { console.log('[Push] web-push not available'); return; }
  try {
    var sb     = getSupabase();
    var result = await sb.from('push_subscriptions').select('subscription').eq('client_id', clientId);
    if (result.error || !result.data || !result.data.length) return;
    var payload = JSON.stringify({
      title:              title,
      body:               body,
      url:                url || '/dashboard',
      requireInteraction: true
    });
    for (var i = 0; i < result.data.length; i++) {
      try {
        var sub = JSON.parse(result.data[i].subscription);
        await wp.sendNotification(sub, payload);
        console.log('[Push] Sent to client', clientId, ':', title);
      } catch(e) {
        if (e.statusCode === 410) {
          // Subscription expired — remove it
          await sb.from('push_subscriptions').delete().eq('client_id', clientId);
        }
      }
    }
  } catch(e) { console.error('[Push] Error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════
function formatPhone(jid) {
  return (jid || '').replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function humanDelay(min, max) {
  min = min || 800;
  max = max || 1800;
  return new Promise(function(r) { setTimeout(r, min + Math.random() * (max - min)); });
}

async function getClientData(clientId) {
  var sb = getSupabase();
  var cr = await sb.from('clients').select(
    'full_name,whatsapp_number,notification_number,bank_name,account_number,account_name'
  ).eq('id', clientId).single();
  return cr.data || null;
}

async function getCustomerName(clientId, jid) {
  try {
    var sb     = getSupabase();
    var result = await sb.from('customers').select('name').eq('client_id', clientId).eq('jid', jid).single();
    return (result.data && result.data.name) ? result.data.name.split(' ')[0] : formatPhone(jid);
  } catch(e) { return formatPhone(jid); }
}

// ══════════════════════════════════════════════════════════════
//  Receipt State Management
// ══════════════════════════════════════════════════════════════
function isPaymentKeyword(text) {
  var t = (text || '').toLowerCase().trim();
  return PAYMENT_CLAIM_KEYWORDS.some(function(kw) { return t.includes(kw); });
}

function isAwaitingReceipt(clientId, jid) {
  var key = clientId + ':' + jid;
  var entry = pendingReceiptRequests.get(key);
  if (!entry) return false;
  // Expire after 10 minutes
  if (Date.now() - entry.ts > 10 * 60 * 1000) {
    pendingReceiptRequests.delete(key);
    return false;
  }
  return true;
}

function getPendingReceiptEntry(clientId, jid) {
  return pendingReceiptRequests.get(clientId + ':' + jid) || null;
}

function clearReceiptRequest(clientId, jid) {
  pendingReceiptRequests.delete(clientId + ':' + jid);
}

// ══════════════════════════════════════════════════════════════
//  Step 1 — Customer claims payment → ask for receipt
// ══════════════════════════════════════════════════════════════
async function handlePaymentClaim(sock, msg, clientId, customerJid, originalMessage) {
  try {
    var client       = await getClientData(clientId);
    var customerName = await getCustomerName(clientId, customerJid);

    if (!client) {
      console.error('[PaymentNotifier] Client not found:', clientId);
      return;
    }

    // Ask customer for receipt photo
    await humanDelay();
    var receiptPrompt =
      'Thank you! 🙏 To confirm your payment, could you please send a *photo or screenshot* of your payment receipt/alert? 📸\n\n' +
      'This helps us verify and confirm your order faster! 😊';
    await sock.sendMessage(customerJid, { text: receiptPrompt });

    // Store pending receipt request
    var key = clientId + ':' + customerJid;
    pendingReceiptRequests.set(key, {
      ownerJid:        client.notification_number
                        ? client.notification_number.replace(/\D/g,'') + '@s.whatsapp.net'
                        : client.whatsapp_number.replace(/\D/g,'') + '@s.whatsapp.net',
      customerName:    customerName,
      originalMessage: originalMessage,
      ts:              Date.now()
    });

    console.log('[PaymentNotifier] Awaiting receipt from', customerJid, 'for client', clientId);
  } catch(e) { console.error('[PaymentNotifier] handlePaymentClaim error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Step 2 — Customer sends receipt image → forward to owner
// ══════════════════════════════════════════════════════════════
async function handleReceiptImage(sock, msg, clientId, customerJid) {
  try {
    var entry = getPendingReceiptEntry(clientId, customerJid);
    if (!entry) return;

    var ownerJid     = entry.ownerJid;
    var customerName = entry.customerName;
    var phone        = formatPhone(customerJid);

    // Download image from message
    var imageMessage = msg.message && msg.message.imageMessage;
    if (!imageMessage) return;

    var msgType  = 'imageMessage';
    var msgForward = msg.message;

    // Forward the actual image to owner
    await humanDelay();

    // Send text alert to owner first
    var alertText =
      '*💰 PAYMENT RECEIPT RECEIVED*\n\n' +
      'Customer: *' + customerName + '* (+' + phone + ')\n' +
      'Time: ' + new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) + '\n\n' +
      '_Verify the receipt below, then reply with a number:_\n\n' +
      '*1* ✅ Payment confirmed — notify customer\n' +
      '*2* ⏳ Ask customer to wait\n' +
      '*3* ❌ Payment not received — notify customer';

    await sock.sendMessage(ownerJid, { text: alertText });
    await humanDelay(500, 1000);

    // Forward the receipt image
    try {
      var { downloadMediaMessage } = require('@whiskeysockets/baileys');
      var buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger:        console,
        reuploadRequest: sock.updateMediaMessage
      });
      if (buffer) {
        await sock.sendMessage(ownerJid, {
          image:   buffer,
          caption: '📎 Receipt from ' + customerName + ' (+' + phone + ')'
        });
      }
    } catch(e) {
      // If download fails, just send a placeholder
      console.error('[PaymentNotifier] Image download failed:', e.message);
      await sock.sendMessage(ownerJid, { text: '_[Image receipt could not be forwarded — check WhatsApp directly]_' });
    }

    // Send push notification to client
    await sendPushToClient(clientId,
      '💰 Payment Receipt Received',
      customerName + ' (+' + phone + ') sent their payment receipt. Confirm in dashboard.',
      '/dashboard'
    );

    // Store pending confirmation (awaiting owner's 1/2/3 reply)
    var confirmKey = ownerJid + ':' + clientId;
    pendingConfirmations.set(confirmKey, {
      customerJid:  customerJid,
      customerName: customerName,
      phone:        phone,
      ts:           Date.now()
    });

    // Clear receipt request — we've received it
    clearReceiptRequest(clientId, customerJid);

    console.log('[PaymentNotifier] Receipt forwarded to owner for client', clientId);
  } catch(e) { console.error('[PaymentNotifier] handleReceiptImage error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Owner replies 1 / 2 / 3
// ══════════════════════════════════════════════════════════════
async function handleOwnerReply(sock, msg, clientId, ownerJid, replyText) {
  try {
    var choice = replyText.trim();

    // Find pending confirmation for this owner+client combo
    var confirmKey    = ownerJid + ':' + clientId;
    var confirmation  = pendingConfirmations.get(confirmKey);
    if (!confirmation) return false;

    // Expire after 30 minutes
    if (Date.now() - confirmation.ts > 30 * 60 * 1000) {
      pendingConfirmations.delete(confirmKey);
      return false;
    }

    if (choice !== '1' && choice !== '2' && choice !== '3') return false;

    var { customerJid, customerName } = confirmation;

    await humanDelay();

    if (choice === '1') {
      // Confirmed
      pendingConfirmations.delete(confirmKey);
      await sock.sendMessage(customerJid, {
        text: '✅ *Payment confirmed!*\n\nThank you ' + customerName + '! Your payment has been verified.\n\nYour order is being processed and we\'ll keep you updated. 🎉'
      });
      // Push to client app
      await sendPushToClient(clientId,
        '✅ Payment Confirmed',
        'You confirmed payment from ' + customerName + ' (+' + confirmation.phone + ').',
        '/dashboard'
      );
      // Log in DB
      try {
        var sb = getSupabase();
        await sb.from('bot_status_log').insert({
          client_id: clientId,
          log_type:  'payment_confirmed',
          note:      'Confirmed payment from ' + customerName + ' (+' + confirmation.phone + ')'
        });
      } catch(e) {}
    } else if (choice === '2') {
      // Wait
      await sock.sendMessage(customerJid, {
        text: '⏳ *Payment processing*\n\nHi ' + customerName + '! We\'ve received your receipt and are verifying your payment. We\'ll confirm shortly. Please be patient! 🙏'
      });
      // Keep confirmation in map for further reply
    } else if (choice === '3') {
      // Not received
      pendingConfirmations.delete(confirmKey);
      var client = await getClientData(clientId);
      var bankInfo = '';
      if (client && client.account_number) {
        bankInfo = '\n\n*Payment Details:*\n' +
          (client.bank_name      ? '🏦 Bank: ' + client.bank_name + '\n'          : '') +
          (client.account_number ? '📋 Account: ' + client.account_number + '\n'  : '') +
          (client.account_name   ? '👤 Name: ' + client.account_name               : '');
      }
      await sock.sendMessage(customerJid, {
        text: '❌ *Payment not found*\n\nHi ' + customerName + ', we could not verify your payment yet.\n\nKindly check and ensure you sent to the correct account.' + bankInfo + '\n\nIf you believe this is an error, please contact us directly.'
      });
    }

    return true;
  } catch(e) {
    console.error('[PaymentNotifier] handleOwnerReply error:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
//  Check if message is from owner and is a 1/2/3 reply
// ══════════════════════════════════════════════════════════════
async function isOwnerConfirmationReply(clientId, senderJid) {
  try {
    var client = await getClientData(clientId);
    if (!client) return false;
    var ownerNum  = (client.notification_number || client.whatsapp_number).replace(/\D/g,'');
    var senderNum = senderJid.replace('@s.whatsapp.net','').replace('@g.us','');
    return ownerNum === senderNum;
  } catch(e) { return false; }
}

function hasPendingConfirmation(clientId, ownerJid) {
  return pendingConfirmations.has(ownerJid + ':' + clientId);
}

// ══════════════════════════════════════════════════════════════
//  Notify owner of human handoff (from replyEngine)
// ══════════════════════════════════════════════════════════════
async function notifyOwnerOfHandoff(sock, clientId, customerJid, customerName, reason) {
  try {
    var client = await getClientData(clientId);
    if (!client) return;
    var ownerJid   = (client.notification_number || client.whatsapp_number).replace(/\D/g,'') + '@s.whatsapp.net';
    var phone      = formatPhone(customerJid);
    var appUrl     = process.env.APP_URL || 'https://forgebot.up.railway.app';

    var alertText =
      '*🤝 CUSTOMER NEEDS ATTENTION*\n\n' +
      'Customer: *' + (customerName || phone) + '* (+' + phone + ')\n' +
      (reason ? 'Reason: ' + reason + '\n' : '') +
      'Time: ' + new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) + '\n\n' +
      '📲 Reply to them directly or view in dashboard:\n' + appUrl + '/dashboard';

    await sock.sendMessage(ownerJid, { text: alertText });

    await sendPushToClient(clientId,
      '🤝 Customer Needs You',
      (customerName || phone) + ' needs your personal attention. Check WhatsApp.',
      '/dashboard'
    );
  } catch(e) { console.error('[PaymentNotifier] notifyOwnerOfHandoff error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Notify owner of new order
// ══════════════════════════════════════════════════════════════
async function notifyOwnerOfOrder(clientId, customerName, orderSummary) {
  try {
    await sendPushToClient(clientId,
      '🛍️ New Order!',
      (customerName || 'A customer') + ' just placed an order: ' + (orderSummary || '').slice(0, 60),
      '/dashboard'
    );
  } catch(e) { console.error('[PaymentNotifier] notifyOwnerOfOrder error:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  v2 API compatibility wrappers
//  replyEngine.js calls the OLD function names — these bridge them
// ══════════════════════════════════════════════════════════════

// isPaymentClaim → isPaymentKeyword
function isPaymentClaim(text) {
  return isPaymentKeyword(text);
}

// notifyOwnerOfPaymentClaim(sock, clientId, customerJid, customerMessage)
// v3 equivalent: handlePaymentClaim(sock, msg, clientId, customerJid, originalMessage)
// We don't have the msg here (replyEngine gives us text only), so we skip receipt request
// and notify owner directly — simpler but still functional
async function notifyOwnerOfPaymentClaim(sock, clientId, customerJid, customerMessage) {
  try {
    var client = await getClientData(clientId);
    if (!client) return;

    var ownerJid = ((client.notification_number || client.whatsapp_number) || '')
      .replace(/\D/g, '') + '@s.whatsapp.net';
    if (!ownerJid || ownerJid === '@s.whatsapp.net') return;

    var phone      = formatPhone(customerJid);
    var alertText  =
      '*💰 PAYMENT ALERT*\n\n' +
      'Customer: +' + phone + '\n' +
      'Message: _"' + (customerMessage || '') + '"_\n\n' +
      'Reply with a number:\n' +
      '*1* ✅ Payment confirmed\n' +
      '*2* ⏳ Ask customer to wait\n' +
      '*3* ❌ Payment not received';

    await sock.sendMessage(ownerJid, { text: alertText });

    // Store so handleOwnerReply can find it
    var confirmKey = ownerJid + ':' + clientId;
    pendingConfirmations.set(confirmKey, {
      customerJid:  customerJid,
      customerName: phone,
      phone:        phone,
      ts:           Date.now()
    });

    await sendPushToClient(clientId,
      '💰 Payment Claim Received',
      'Customer +' + phone + ' claims they paid. Review in dashboard.',
      '/dashboard'
    );

    console.log('[PaymentNotifier] Owner alerted for client', clientId);
  } catch(e) {
    console.error('[PaymentNotifier] notifyOwnerOfPaymentClaim error:', e.message);
  }
}

// handleOwnerReply(sock, fromJid, text, clientId)  ← v2 signature replyEngine uses
// Internally uses v3 logic
async function handleOwnerReplyV2(sock, fromJid, text, clientId) {
  try {
    if (!fromJid || !text || !clientId) return false;

    var client = await getClientData(clientId);
    if (!client) return false;

    // Build expected owner JID (phone digits + @s.whatsapp.net)
    var ownerPhone = ((client.notification_number || client.whatsapp_number) || '').replace(/\D/g, '');
    if (!ownerPhone) return false;

    // Compare digits only — handles @lid, @s.whatsapp.net, different country prefixes
    var fromDigits  = fromJid.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
    var isOwner     = (fromDigits === ownerPhone) ||
                      (ownerPhone.length >= 10 && fromDigits.endsWith(ownerPhone.slice(-10))) ||
                      (fromDigits.length >= 10 && ownerPhone.endsWith(fromDigits.slice(-10)));

    if (!isOwner) return false;

    // Check there's a pending confirmation
    var ownerJid   = ownerPhone + '@s.whatsapp.net';
    var confirmKey = ownerJid + ':' + clientId;
    if (!pendingConfirmations.has(confirmKey)) return false;

    // Delegate to v3 handleOwnerReply
    return await handleOwnerReply(sock, null, clientId, ownerJid, text);
  } catch(e) {
    console.error('[PaymentNotifier] handleOwnerReply error:', e.message);
    return false;
  }
}

// notifyOwnerHumanRequest(sock, clientId, customerJid) ← v2 name
async function notifyOwnerHumanRequest(sock, clientId, customerJid) {
  return notifyOwnerOfHandoff(sock, clientId, customerJid, null, 'Customer requested human support');
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
  // ── v2 API (what replyEngine.js imports by name) ──────────
  isPaymentClaim,                    // ← was missing → bot crashed every message
  notifyOwnerOfPaymentClaim,         // ← wrapper around v3 logic
  handleOwnerReply: handleOwnerReplyV2, // ← v2 signature (sock, fromJid, text, clientId)
  notifyOwnerHumanRequest,           // ← alias for notifyOwnerOfHandoff
  pendingConfirmations,

  // ── v3 API (full feature set) ────────────────────────────
  isPaymentKeyword,
  isAwaitingReceipt,
  handlePaymentClaim,
  handleReceiptImage,
  isOwnerConfirmationReply,
  hasPendingConfirmation,
  notifyOwnerOfHandoff,
  notifyOwnerOfOrder,
  sendPushToClient
};
