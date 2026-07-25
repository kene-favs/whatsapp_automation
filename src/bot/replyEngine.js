// ============================================================
//  ForgeBot — Reply Engine
//  ALL EXISTING LOGIC PRESERVED — paymentNotifier v3 API fix
// ============================================================

'use strict';

const db = require('../db/supabase');
const { matchKeyword } = require('./keywords');
const { transcribeVoiceNote } = require('./voiceHandler');

// ── paymentNotifier v3 API ────────────────────────────────────
const {
  isPaymentKeyword,
  isAwaitingReceipt,
  handlePaymentClaim,
  handleReceiptImage,
  handleOwnerReply,
  isOwnerConfirmationReply,
  hasPendingConfirmation,
  notifyOwnerOfHandoff
} = require('./paymentNotifier');

// ── Human handoff pause map ────────────────────────────────
const humanPaused = new Map();

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

function wantsHuman(text) {
  var lower = text.toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

// ── @lid JID normalization ────────────────────────────────────
// WhatsApp Linked Identity (@lid) JIDs are device-level encryption IDs.
// Sending messages to @lid can result in silent delivery failures on the
// recipient's phone. Normalising to @s.whatsapp.net fixes this.
function normalizeSendJid(jid) {
  if (jid && jid.endsWith('@lid')) {
    return jid.replace('@lid', '@s.whatsapp.net');
  }
  return jid;
}

// ── Smart listings search ──────────────────────────────────
async function searchListings(clientId, query) {
  try {
    var sb = db.getSupabase();
    var lower = query.toLowerCase();

    var result = await sb
      .from('service_listings')
      .select('*, listing_media(url, media_type, sort_order)')
      .eq('client_id', clientId)
      .eq('available', true)
      .order('created_at', { ascending: false });

    if (result.error || !result.data || !result.data.length) return [];

    var scored = result.data.map(function(listing) {
      var score = 0;
      var fields = [
        listing.name        || '',
        listing.description || '',
        listing.keywords    || '',
        listing.category    || '',
        listing.location    || '',
        listing.price_label || ''
      ].map(function(f) { return f.toLowerCase(); });

      var words = lower.split(/\s+/).filter(function(w) { return w.length > 2; });
      words.forEach(function(word) {
        fields.forEach(function(field) {
          if (field.includes(word)) score += word.length;
        });
      });

      if (fields[0].includes(lower)) score += 20;
      return { listing: listing, score: score };
    });

    return scored
      .filter(function(s) { return s.score > 0; })
      .sort(function(a, b) { return b.score - a.score; })
      .slice(0, 3)
      .map(function(s) { return s.listing; });
  } catch (e) {
    console.error('[ReplyEngine] Listing search error:', e.message);
    return [];
  }
}

const LISTING_TRIGGERS = [
  'do you have', 'do you sell', 'do you offer', 'is it available', 'price of',
  'how much is', 'how much for', 'what is the price', 'i want to buy', 'i want to order',
  'i need', 'looking for', 'show me', 'send me', 'any available', 'in stock',
  'do you do', 'can you do', 'available for', 'services', 'products', 'what do you have',
  'what do you sell', 'your prices', 'package', 'packages', 'catalogue', 'catalog',
  'bedroom', 'apartment', 'house', 'land', 'property', 'plot', 'duplex', 'flat',
  'size', 'colour', 'color', 'style', 'design', 'type', 'model'
];

function isListingQuery(text) {
  var lower = text.toLowerCase();
  return LISTING_TRIGGERS.some(function(t) { return lower.includes(t); });
}

async function sendListingResults(sock, jid, listings, client) {
  if (!listings.length) return false;

  if (listings.length === 1) {
    var l = listings[0];
    var msg = '✅ Yes! Here is what we have:\n\n';
    msg += '*' + l.name + '*\n';
    if (l.price) msg += '💰 *Price:* ' + l.price + '\n';
    if (l.description) msg += '📝 ' + l.description + '\n';
    if (l.location) msg += '📍 *Location:* ' + l.location + '\n';
    msg += '\nInterested? DM us or reply to place your order! 😊';

    await sock.sendMessage(jid, { text: msg });

    var media = (l.listing_media || []).filter(function(m) { return m.media_type === 'image'; });
    for (var i = 0; i < Math.min(media.length, 3); i++) {
      try {
        await sock.sendMessage(jid, { image: { url: media[i].url }, caption: l.name });
        await new Promise(function(r) { setTimeout(r, 800); });
      } catch (e) {}
    }

    var pdf = (l.listing_media || []).find(function(m) { return m.media_type === 'pdf'; });
    if (pdf) {
      try {
        await sock.sendMessage(jid, {
          document: { url: pdf.url },
          mimetype: 'application/pdf',
          fileName: l.name + '.pdf',
          caption:  'Full details for ' + l.name
        });
      } catch (e) {}
    }
  } else {
    var intro = '✅ We found *' + listings.length + ' options* for you:\n\n';
    listings.forEach(function(l, i) {
      intro += '*' + (i + 1) + '. ' + l.name + '*\n';
      if (l.price)       intro += '   💰 ' + l.price + '\n';
      if (l.location)    intro += '   📍 ' + l.location + '\n';
      if (l.description) intro += '   ' + l.description.slice(0, 80) + (l.description.length > 80 ? '...' : '') + '\n';
      intro += '\n';
    });
    intro += 'Reply with the *number* of the one you want more details on, or DM us directly! 😊';
    await sock.sendMessage(jid, { text: intro });

    for (var j = 0; j < listings.length; j++) {
      var imgs = (listings[j].listing_media || []).filter(function(m) { return m.media_type === 'image'; });
      if (imgs.length) {
        try {
          await sock.sendMessage(jid, {
            image:   { url: imgs[0].url },
            caption: '*' + (j + 1) + '.* ' + listings[j].name + (listings[j].price ? ' — ' + listings[j].price : '')
          });
          await new Promise(function(r) { setTimeout(r, 800); });
        } catch (e) {}
      }
    }
  }
  return true;
}

// ── Main message handler ───────────────────────────────────

async function handleMessage(sock, msg, clientId) {
  try {
    var jid = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    // Normalize @lid to @s.whatsapp.net for sending — @lid JIDs cause
    // silent delivery failures on the recipient's phone in Baileys v6.7.
    // We keep the original jid for presence updates and state tracking
    // (those work fine with @lid), and use sendJid for all sendMessage calls.
    var sendJid = normalizeSendJid(jid);
    if (sendJid !== jid) {
      console.log('[ReplyEngine] @lid normalized for sending:', jid, '→', sendJid);
    }

    var msgContent = msg.message;
    var isVoice    = !!(msgContent && msgContent.audioMessage && msgContent.audioMessage.ptt);
    var isAudio    = !!(msgContent && msgContent.audioMessage);
    var isImage    = !!(msgContent && msgContent.imageMessage);

    var text = (msgContent && msgContent.conversation) ||
               (msgContent && msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent && msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    console.log('[ReplyEngine] MSG from', jid, '| text:', (text || '').slice(0, 30), '| isImage:', isImage);

    // ── Receipt image check (must be before text guard) ────────
    if (isImage && !text) {
      if (isAwaitingReceipt(clientId, jid)) {
        await handleReceiptImage(sock, msg, clientId, sendJid);
        return;
      }
    }

    // ── Voice note handling ─────────────────────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      var transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(sendJid, {
          text: 'I received your voice note! Could you please type your message so I can help you faster?'
        });
        return;
      }
      text = transcribed;
      await sock.sendMessage(sendJid, {
        text: 'I heard: _"' + transcribed + '"_\n\nLet me help you with that...'
      });
    }

    if (!text || !text.trim()) {
      console.log('[ReplyEngine] Empty text — skipping');
      return;
    }

    // ── Get client ──────────────────────────────────────────────
    var client = await db.getClientById(clientId);
    console.log('[ReplyEngine] client status:', client && client.status, '| sub_active:', client && client.subscription_active);
    if (!client || client.status !== 'active' || !client.subscription_active) {
      console.log('[ReplyEngine] Client not eligible — returning');
      return;
    }

    // ── Track customer ──────────────────────────────────────────
    try {
      var sb = db.getSupabase();
      await sb.from('customers').upsert({
        client_id:    clientId,
        jid:          jid,
        last_contact: new Date().toISOString(),
        last_seen:    new Date().toISOString()
      }, { onConflict: 'client_id,jid', ignoreDuplicates: false });
    } catch (e) {}

    // ── Owner confirmation reply check (v3 API) ─────────────────
    try {
      var senderIsOwner = await isOwnerConfirmationReply(clientId, jid);
      if (senderIsOwner) {
        var ownerNum = ((client.notification_number || client.whatsapp_number) || '').replace(/\D/g, '');
        var ownerJid = ownerNum + '@s.whatsapp.net';
        if (hasPendingConfirmation(clientId, ownerJid)) {
          var ownerHandled = await handleOwnerReply(sock, msg, clientId, ownerJid, text);
          if (ownerHandled) return;
        }
      }
    } catch (e) {
      console.error('[ReplyEngine] ownerReply check error:', e.message);
    }

    // ── Human pause check ───────────────────────────────────────
    var pauseKey    = clientId + ':' + jid;
    var pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) {
      console.log('[ReplyEngine] Human pause active — skipping');
      return;
    }
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff detection ─────────────────────────────────
    if (wantsHuman(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(sendJid, {
        text: 'Got it! I am connecting you with the owner right now. Please hold on — they will be with you shortly.'
      });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000);
      await notifyOwnerOfHandoff(sock, clientId, sendJid, null, 'customer requested human');
      return;
    }

    // ── Payment claim detection (v3 API) ────────────────────────
    if (isPaymentKeyword(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await handlePaymentClaim(sock, msg, clientId, sendJid, text);
      return;
    }

    // ── Awaiting receipt — remind customer to send photo ────────
    if (isAwaitingReceipt(clientId, jid)) {
      await humanDelay();
      await sock.sendMessage(sendJid, {
        text: 'Please send a *photo or screenshot* of your payment receipt to confirm. 📸'
      });
      return;
    }

    console.log('[ReplyEngine] Sending composing to', jid);
    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    // ── Smart listing search (before keyword matching) ───────────
    if (isListingQuery(text)) {
      var matches = await searchListings(clientId, text);
      if (matches.length > 0) {
        var sent = await sendListingResults(sock, sendJid, matches, client);
        if (sent) return;
      }
    }

    // ── Flow keyword matching ────────────────────────────────────
    var flows = [];
    try {
      flows = (await db.getFlows(clientId, true)) || [];
      console.log('[ReplyEngine] Loaded', flows.length, 'flows');
    } catch (e) {
      console.error('[ReplyEngine] getFlows error for client ' + clientId + ':', e.message);
    }
    var matched = null;
    for (var i = 0; i < flows.length; i++) {
      var flow = flows[i];
      if (!flow.keywords) continue;
      var kws       = flow.keywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
      var textLower = text.toLowerCase();
      if (kws.some(function(kw) { return textLower.includes(kw); })) {
        matched = flow;
        break;
      }
    }

    if (matched) {
      console.log('[ReplyEngine] Keyword match:', matched.keywords);
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(sendJid, { image: { url: matched.media_url }, caption: matched.response });
      } else {
        await sock.sendMessage(sendJid, { text: matched.response });
      }
      return;
    }

    // ── Broader listing search (no keyword match found) ──────────
    if (!isListingQuery(text)) {
      var broadMatches = await searchListings(clientId, text);
      if (broadMatches.length > 0) {
        var broadSent = await sendListingResults(sock, sendJid, broadMatches, client);
        if (broadSent) return;
      }
    }

    // ── Fallback message ─────────────────────────────────────────
    var fallback = client.fallback_message ||
      'Thank you for reaching out! Someone will get back to you shortly.';
    console.log('[ReplyEngine] Sending fallback to', sendJid);
    await sock.sendMessage(sendJid, { text: fallback });
    console.log('[ReplyEngine] Fallback sent OK');

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
