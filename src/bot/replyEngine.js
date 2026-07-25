'use strict';

const db = require('../db/supabase');
const { transcribeVoiceNote } = require('./voiceHandler');

// ── Import paymentNotifier with safe destructuring ─────────────
// The deployed version may be v2 or v3 — we guard every call with typeof.
var paymentNotifier = {};
try { paymentNotifier = require('./paymentNotifier'); } catch (e) {
  console.warn('[ReplyEngine] Could not load paymentNotifier:', e.message);
}

var isPaymentKeyword         = typeof paymentNotifier.isPaymentKeyword         === 'function' ? paymentNotifier.isPaymentKeyword         : null;
var isAwaitingReceipt        = typeof paymentNotifier.isAwaitingReceipt        === 'function' ? paymentNotifier.isAwaitingReceipt        : null;
var handlePaymentClaim       = typeof paymentNotifier.handlePaymentClaim       === 'function' ? paymentNotifier.handlePaymentClaim       : null;
var handleReceiptImage       = typeof paymentNotifier.handleReceiptImage       === 'function' ? paymentNotifier.handleReceiptImage       : null;
var handleOwnerReply         = typeof paymentNotifier.handleOwnerReply         === 'function' ? paymentNotifier.handleOwnerReply         : null;
var isOwnerConfirmationReply = typeof paymentNotifier.isOwnerConfirmationReply === 'function' ? paymentNotifier.isOwnerConfirmationReply : null;
var hasPendingConfirmation   = typeof paymentNotifier.hasPendingConfirmation   === 'function' ? paymentNotifier.hasPendingConfirmation   : null;
var notifyOwnerOfHandoff     = typeof paymentNotifier.notifyOwnerOfHandoff     === 'function' ? paymentNotifier.notifyOwnerOfHandoff     : null;

// ── Human handoff ─────────────────────────────────────────────
const humanPaused = new Map(); // jid → true (bot paused, human handling)

const HUMAN_HANDOFF_KEYWORDS = [
  'talk to human', 'speak to human', 'real person', 'agent please',
  'customer service', 'human please', 'i want to talk to someone',
  'connect me to someone', 'i need a human', 'speak to agent',
  'talk to agent', 'speak to a person', 'i want a human'
];

function wantsHuman(text) {
  var lower = text.toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

function humanDelay() {
  var ms = 800 + Math.floor(Math.random() * 1200);
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Smart listings search ─────────────────────────────────────
var LISTING_TRIGGERS = [
  'do you have', 'do you sell', 'how much', 'price of', 'cost of',
  'cost for', 'price for', 'what is the price', 'i want to buy',
  'i need', 'looking for', 'available', 'in stock', 'sell', 'show me'
];

function isListingQuery(text) {
  var lower = text.toLowerCase();
  return LISTING_TRIGGERS.some(function(t) { return lower.includes(t); });
}

async function searchListings(clientId, text) {
  try {
    var sb     = db.getSupabase ? db.getSupabase() : null;
    if (!sb) return [];
    var result = await sb
      .from('service_listings')
      .select('name, price, price_label, description, keywords')
      .eq('client_id', clientId)
      .eq('available', true);
    if (result.error || !result.data || !result.data.length) return [];
    var lower = text.toLowerCase();
    return result.data.filter(function(item) {
      var searchable = ((item.name || '') + ' ' + (item.keywords || '') + ' ' + (item.description || '')).toLowerCase();
      return lower.split(/\s+/).some(function(word) {
        return word.length > 2 && searchable.includes(word);
      });
    }).slice(0, 5);
  } catch (e) {
    return [];
  }
}

function buildListingReply(matches) {
  if (!matches.length) return null;
  var lines = matches.map(function(m) {
    var price = m.price_label || (m.price ? '₦' + Number(m.price).toLocaleString() : null);
    return '• *' + m.name + '*' + (price ? ' — ' + price : '') + (m.description ? '\n  ' + m.description.slice(0, 80) : '');
  });
  return 'Here\'s what I found:\n\n' + lines.join('\n\n');
}

// ════════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ════════════════════════════════════════════════════════════════

async function handleMessage(sock, msg, clientId) {
  try {
    var jid = msg.key.remoteJid;
    if (!jid) return;
    if (jid === 'status@broadcast') return;

    var msgContent = msg.message;
    if (!msgContent) return;

    var isImage = !!(msgContent.imageMessage);
    var isVoice = !!(msgContent.audioMessage && msgContent.audioMessage.ptt);
    var isAudio = !!(msgContent.audioMessage);

    var text = (msgContent.conversation)
            || (msgContent.extendedTextMessage && msgContent.extendedTextMessage.text)
            || (msgContent.imageMessage && msgContent.imageMessage.caption)
            || (msgContent.videoMessage && msgContent.videoMessage.caption)
            || '';

    console.log('[ReplyEngine] MSG from', jid, '| text:', text.slice(0, 60), '| isImage:', isImage, '| isVoice:', isVoice);

    // ── Voice note: transcribe and treat as text ───────────────
    if (isVoice && !text.trim()) {
      try {
        var transcribed = await transcribeVoiceNote(msg);
        if (transcribed) {
          text = transcribed;
          console.log('[ReplyEngine] Transcribed voice:', text.slice(0, 60));
        }
      } catch (e) {
        console.log('[ReplyEngine] Voice transcription failed:', e.message);
      }
    }

    // Skip if nothing to process
    if (!text.trim() && !isImage) {
      console.log('[ReplyEngine] Empty message, skipping');
      return;
    }

    // ── Load client ───────────────────────────────────────────
    var client = await db.getClientById(clientId);
    if (!client) {
      console.log('[ReplyEngine] No client found:', clientId);
      return;
    }
    console.log('[ReplyEngine] client status:', client.status, '| sub_active:', client.subscription_active);

    if (client.status !== 'active' || !client.subscription_active) {
      console.log('[ReplyEngine] Client inactive or no subscription, skipping');
      return;
    }

    // ── Track customer ────────────────────────────────────────
    try {
      var sb = db.getSupabase ? db.getSupabase() : null;
      if (sb) {
        await sb.from('customers').upsert({
          client_id:    clientId,
          jid:          jid,
          last_contact: new Date().toISOString()
        }, { onConflict: 'client_id,jid', ignoreDuplicates: false });
      }
    } catch (e) {
      // non-critical
    }

    console.log('[ReplyEngine] Passed customer tracking');

    // ── Receipt image (paymentNotifier v3) ───────────────────
    if (isImage && isAwaitingReceipt && isAwaitingReceipt(jid)) {
      console.log('[ReplyEngine] Handling receipt image');
      if (handleReceiptImage) await handleReceiptImage(sock, msg, clientId);
      return;
    }

    // ── Owner confirmation reply (paymentNotifier v3) ────────
    if (text.trim()) {
      var isOwnerReply = (isOwnerConfirmationReply && isOwnerConfirmationReply(text))
                      || (hasPendingConfirmation && hasPendingConfirmation(jid));
      if (isOwnerReply) {
        console.log('[ReplyEngine] Handling owner confirmation reply');
        if (handleOwnerReply) {
          var ownerJid = null;
          try {
            var ownerNum = client.notification_number;
            if (ownerNum) ownerJid = ownerNum.replace(/\D/g, '') + '@s.whatsapp.net';
          } catch (e) {}
          await handleOwnerReply(sock, msg, clientId, ownerJid, text.trim());
        }
        return;
      }
    }

    // ── Human pause check ────────────────────────────────────
    if (humanPaused.get(jid)) {
      console.log('[ReplyEngine] Bot paused for human handoff on', jid);
      return;
    }

    // ── Human handoff request ────────────────────────────────
    if (text.trim() && wantsHuman(text)) {
      console.log('[ReplyEngine] Human handoff requested by', jid);
      humanPaused.set(jid, true);
      if (notifyOwnerOfHandoff) {
        try { await notifyOwnerOfHandoff(sock, msg, clientId); } catch (e) {}
      }
      var handoffMsg = 'I\'ll connect you with our team right away! A human agent will be with you shortly. 🙏';
      await sock.sendMessage(jid, { text: handoffMsg });
      return;
    }

    // ── Payment keyword (paymentNotifier v3) ─────────────────
    if (text.trim() && isPaymentKeyword && isPaymentKeyword(text)) {
      console.log('[ReplyEngine] Payment keyword detected');
      if (handlePaymentClaim) await handlePaymentClaim(sock, msg, clientId);
      return;
    }

    // ── Typing indicator ──────────────────────────────────────
    try {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendPresenceUpdate('paused', jid);
    } catch (e) {
      console.log('[ReplyEngine] Presence update failed:', e.message);
    }

    // ── Smart listings search (before keyword matching) ───────
    if (text.trim() && isListingQuery(text)) {
      var matches = await searchListings(clientId, text);
      if (matches.length) {
        var listingReply = buildListingReply(matches);
        if (listingReply) {
          console.log('[ReplyEngine] Sending listings reply to', jid);
          await sock.sendMessage(jid, { text: listingReply });
          return;
        }
      }
    }

    // ── Keyword / flow matching ───────────────────────────────
    var flows = await db.getFlows(clientId, true);
    console.log('[ReplyEngine] Loaded', flows.length, 'flows');

    if (text.trim() && flows.length) {
      var lower = text.toLowerCase();
      for (var i = 0; i < flows.length; i++) {
        var flow = flows[i];
        var kws  = (flow.keywords || '').toLowerCase().split(',').map(function(k) { return k.trim(); }).filter(Boolean);
        var matched = kws.some(function(kw) { return lower.includes(kw); });
        if (matched) {
          console.log('[ReplyEngine] Matched flow:', flow.id, '| keyword hit on:', kws.find(function(kw) { return lower.includes(kw); }));
          if (flow.response_type === 'image' && flow.media_url) {
            await sock.sendMessage(jid, {
              image: { url: flow.media_url },
              caption: flow.response || ''
            });
          } else {
            await sock.sendMessage(jid, { text: flow.response || '' });
          }
          // Update trigger count
          try {
            var sbf = db.getSupabase ? db.getSupabase() : null;
            if (sbf) await sbf.from('chat_flows').update({ trigger_count: (flow.trigger_count || 0) + 1 }).eq('id', flow.id);
          } catch (e) {}
          return;
        }
      }
    }

    // ── Broader listings fallback ─────────────────────────────
    if (text.trim()) {
      var broadMatches = await searchListings(clientId, text);
      if (broadMatches.length) {
        var broadReply = buildListingReply(broadMatches);
        if (broadReply) {
          console.log('[ReplyEngine] Sending broad listings reply to', jid);
          await sock.sendMessage(jid, { text: broadReply });
          return;
        }
      }
    }

    // ── Fallback message ──────────────────────────────────────
    var fallback = client.fallback_message
      || 'Thank you for reaching out! 😊 I didn\'t quite understand that. You can ask about our products, prices, or services and I\'ll do my best to help!';
    console.log('[ReplyEngine] Sending fallback to', jid);
    await sock.sendMessage(jid, { text: fallback });
    console.log('[ReplyEngine] Fallback sent OK');

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message, err.stack ? err.stack.split('\n')[1] : '');
  }
}

module.exports = { handleMessage };
