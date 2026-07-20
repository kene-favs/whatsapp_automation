// ============================================================
//  ForgeBot — Payment Notifier v4
//  src/bot/paymentNotifier.js
//
//  v4 changes:
//   - Owner confirms payment on DASHBOARD only (no WhatsApp 1/2/3)
//   - When receipt received: upload to storage → save URL on order
//     → push notification + WhatsApp link to dashboard
//   - Lead notifications for listing queries (called from replyEngine)
//   - Human handoff notification preserved
// ============================================================
'use strict';

const { createClient } = require('@supabase/supabase-js');

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

// ── Receipt request state ─────────────────────────────────────
// key: clientId + ':' + customerJid → { ownerJid, customerName, ts }
var pendingReceiptRequests = new Map();

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
//  Push Notifications
// ══════════════════════════════════════════════════════════════
async function sendPushToClient(clientId, title, body, url) {
  var wp = getWebPush();
  if (!wp) return;
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
        console.log('[Push] Sent:', title);
      } catch(e) {
        if (e.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('client_id', clientId);
        }
      }
    }
  } catch(e) { console.error('[Push]', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════
function formatPhone(jid) {
  return (jid || '').replace('@s.whatsapp.net', '').replace('@g.us', '');
}

async function humanDelay(min, max) {
  min = min || 800; max = max || 1800;
  return new Promise(function(r) { setTimeout(r, min + Math.random() * (max - min)); });
}

async function getClientData(clientId) {
  var sb = getSupabase();
  var cr = await sb.from('clients').select(
    'full_name,whatsapp_number,notification_number,bank_name,account_number,account_name,business_name'
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
//  Receipt State
// ══════════════════════════════════════════════════════════════
function isPaymentKeyword(text) {
  var t = (text || '').toLowerCase().trim();
  return PAYMENT_CLAIM_KEYWORDS.some(function(kw) { return t.includes(kw); });
}

function isAwaitingReceipt(clientId, jid) {
  var key   = clientId + ':' + jid;
  var entry = pendingReceiptRequests.get(key);
  if (!entry) return false;
  if (Date.now() - entry.ts > 10 * 60 * 1000) {
    pendingReceiptRequests.delete(key);
    return false;
  }
  return true;
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
    if (!client) return;

    await humanDelay();
    await sock.sendMessage(customerJid, {
      text: 'Thank you! 🙏 To confirm your payment quickly, please send a *photo or screenshot* of your payment receipt/alert 📸\n\nThis helps us verify and process your order faster!'
    });

    var ownerJid = (client.notification_number || client.whatsapp_number)
      .replace(/\D/g,'') + '@s.whatsapp.net';

    pendingReceiptRequests.set(clientId + ':' + customerJid, {
      ownerJid:     ownerJid,
      customerName: customerName,
      ts:           Date.now()
    });

    console.log('[PaymentNotifier] Awaiting receipt from', customerJid);
  } catch(e) { console.error('[PaymentNotifier] handlePaymentClaim:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Step 2 — Customer sends receipt image
//  → upload to storage → save on order → push owner to dashboard
// ══════════════════════════════════════════════════════════════
async function handleReceiptImage(sock, msg, clientId, customerJid) {
  try {
    var entry = pendingReceiptRequests.get(clientId + ':' + customerJid);
    if (!entry) return;

    var imageMessage = msg.message && msg.message.imageMessage;
    if (!imageMessage) return;

    var ownerJid     = entry.ownerJid;
    var customerName = entry.customerName;
    var phone        = formatPhone(customerJid);
    var appUrl       = process.env.APP_URL || 'https://forgebot.up.railway.app';
    var sb           = getSupabase();
    var receiptUrl   = null;

    // ── Download & upload receipt to Supabase Storage ─────
    try {
      var { downloadMediaMessage } = require('@whiskeysockets/baileys');
      var buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger:          console,
        reuploadRequest: sock.updateMediaMessage
      });
      if (buffer) {
        var filename = 'receipts/' + clientId + '/' + Date.now() + '.jpg';
        var up = await sb.storage.from('forgebot-listings').upload(filename, buffer, {
          contentType: 'image/jpeg',
          upsert:      false
        });
        if (!up.error) {
          var urlRes = sb.storage.from('forgebot-listings').getPublicUrl(filename);
          receiptUrl = urlRes.data.publicUrl;
        }
      }
    } catch(e) { console.error('[PaymentNotifier] Image upload failed:', e.message); }

    // ── Attach receipt to the customer's latest pending order ─
    if (receiptUrl) {
      try {
        var orderRes = await sb.from('orders')
          .select('id')
          .eq('client_id', clientId)
          .eq('customer_jid', customerJid)
          .in('status', ['pending', 'awaiting_payment'])
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (orderRes.data) {
          await sb.from('orders').update({
            receipt_url:    receiptUrl,
            payment_status: 'receipt_received',
            updated_at:     new Date().toISOString()
          }).eq('id', orderRes.data.id);
        } else {
          // No order yet — create a payment_receipts record
          await sb.from('payment_receipts').insert({
            client_id:    clientId,
            customer_jid: customerJid,
            customer_name: customerName,
            receipt_url:  receiptUrl,
            status:       'pending',
            created_at:   new Date().toISOString()
          }).catch(function() {});
        }
      } catch(e) { console.error('[PaymentNotifier] Order update:', e.message); }
    }

    // ── Tell customer receipt was received ─────────────────
    await humanDelay();
    await sock.sendMessage(customerJid, {
      text: '✅ Receipt received! Your payment is being reviewed.\n\nWe will confirm your order shortly. Thank you for your patience! 🙏'
    });

    // ── Notify owner via WhatsApp (link only, no 1/2/3) ───
    var waAlert =
      '💰 *Payment Receipt Received*\n\n' +
      'Customer: *' + customerName + '* (+' + phone + ')\n' +
      'Time: ' + new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) + '\n\n' +
      '👆 Confirm or reject the payment on your dashboard:\n' +
      appUrl + '/dashboard';

    try { await sock.sendMessage(ownerJid, { text: waAlert }); } catch(e) {}

    // ── Push notification to owner's app ──────────────────
    await sendPushToClient(clientId,
      '💰 Payment Receipt Received',
      customerName + ' (+' + phone + ') sent their receipt. Tap to confirm on dashboard.',
      '/dashboard'
    );

    clearReceiptRequest(clientId, customerJid);
    console.log('[PaymentNotifier] Receipt handled for', customerJid);
  } catch(e) { console.error('[PaymentNotifier] handleReceiptImage:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Lead Notification — called from replyEngine after listing match
// ══════════════════════════════════════════════════════════════
async function notifyOwnerOfLead(clientId, customerJid, listingNames) {
  try {
    var phone   = formatPhone(customerJid);
    var preview = (listingNames || []).slice(0, 2).join(', ');
    await sendPushToClient(clientId,
      '🔥 New Lead!',
      '+' + phone + ' is asking about: ' + preview + '. They may want to order!',
      '/dashboard'
    );
  } catch(e) { console.error('[PaymentNotifier] notifyOwnerOfLead:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Human Handoff Notification
// ══════════════════════════════════════════════════════════════
async function notifyOwnerOfHandoff(sock, clientId, customerJid, customerName, reason) {
  try {
    var client   = await getClientData(clientId);
    if (!client) return;
    var ownerJid = (client.notification_number || client.whatsapp_number).replace(/\D/g,'') + '@s.whatsapp.net';
    var phone    = formatPhone(customerJid);
    var appUrl   = process.env.APP_URL || 'https://forgebot.up.railway.app';

    var alertText =
      '🤝 *Customer Needs Attention*\n\n' +
      'Customer: *' + (customerName || phone) + '* (+' + phone + ')\n' +
      (reason ? 'Reason: ' + reason + '\n' : '') +
      'Time: ' + new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }) + '\n\n' +
      '👆 View on your dashboard:\n' + appUrl + '/dashboard';

    try { await sock.sendMessage(ownerJid, { text: alertText }); } catch(e) {}

    await sendPushToClient(clientId,
      '🤝 Customer Needs You',
      (customerName || phone) + ' requested a human. Check WhatsApp.',
      '/dashboard'
    );
  } catch(e) { console.error('[PaymentNotifier] notifyOwnerOfHandoff:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Order Notification
// ══════════════════════════════════════════════════════════════
async function notifyOwnerOfOrder(clientId, customerName, orderSummary) {
  try {
    await sendPushToClient(clientId,
      '🛍️ New Order!',
      (customerName || 'A customer') + ' placed an order: ' + (orderSummary || '').slice(0, 60),
      '/dashboard'
    );
  } catch(e) { console.error('[PaymentNotifier] notifyOwnerOfOrder:', e.message); }
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
  isPaymentKeyword,
  isAwaitingReceipt,
  handlePaymentClaim,
  handleReceiptImage,
  notifyOwnerOfHandoff,
  notifyOwnerOfLead,
  notifyOwnerOfOrder,
  sendPushToClient
};
