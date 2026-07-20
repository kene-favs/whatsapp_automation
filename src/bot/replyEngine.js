// ============================================================
//  ForgeBot — Reply Engine v4
//  MATCHES paymentNotifier.js v4 exports exactly.
//  handleOwnerReply removed. Uses isPaymentKeyword, handlePaymentClaim,
//  handleReceiptImage, isAwaitingReceipt, notifyOwnerOfHandoff, notifyOwnerOfLead.
// ============================================================

'use strict';

const db = require('../db/supabase');
const {
  isPaymentKeyword,
  isAwaitingReceipt,
  handlePaymentClaim,
  handleReceiptImage,
  notifyOwnerOfHandoff,
  notifyOwnerOfLead
} = require('./paymentNotifier');

// ── Human handoff pause map ─────────────────────────────────
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

// ── Smart listings search ───────────────────────────────────
async function searchListings(clientId, query) {
  try {
    var sb    = db.getSupabase();
    var lower = query.toLowerCase();

    var result = await sb
      .from('service_listings')
      .select('*, listing_media(url, media_type, sort_order)')
      .eq('client_id', clientId)
      .eq('available', true)
      .order('created_at', { ascending: false });

    if (result.error || !result.data || !result.data.length) return [];

    var scored = result.data.map(function(listing) {
      var score  = 0;
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
    var l   = listings[0];
    var msg = '✅ Yes! Here is what we have:\n\n';
    msg += '*' + l.name + '*\n';
    if (l.price)       msg += '💰 *Price:* ₦' + Number(l.price).toLocaleString('en-NG') + '\n';
    if (l.price_label) msg += '💰 *Price:* ' + l.price_label + '\n';
    if (l.description) msg += '📝 ' + l.description + '\n';
    if (l.location)    msg += '📍 *Location:* ' + l.location + '\n';
    msg += '\nInterested? Reply to place your order! 😊';

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
          document: { url: pdf.url }, mimetype: 'application/pdf',
          fileName: l.name + '.pdf', caption: 'Full details for ' + l.name
        });
      } catch (e) {}
    }
  } else {
    var intro = '✅ We found *' + listings.length + ' options* for you:\n\n';
    listings.forEach(function(l, i) {
      intro += '*' + (i + 1) + '. ' + l.name + '*\n';
      if (l.price_label)   intro += '   💰 ' + l.price_label + '\n';
      else if (l.price)    intro += '   💰 ₦' + Number(l.price).toLocaleString('en-NG') + '\n';
      if (l.location)      intro += '   📍 ' + l.location + '\n';
      if (l.description)   intro += '   ' + l.description.slice(0, 80) + (l.description.length > 80 ? '...' : '') + '\n';
      intro += '\n';
    });
    intro += 'Reply with the *number* of the one you want more info on 😊';
    await sock.sendMessage(jid, { text: intro });

    for (var j = 0; j < listings.length; j++) {
      var imgs = (listings[j].listing_media || []).filter(function(m) { return m.media_type === 'image'; });
      if (imgs.length) {
        try {
          await sock.sendMessage(jid, {
            image:   { url: imgs[0].url },
            caption: '*' + (j + 1) + '.* ' + listings[j].name +
                     (listings[j].price_label ? ' — ' + listings[j].price_label :
                      listings[j].price ? ' — ₦' + Number(listings[j].price).toLocaleString('en-NG') : '')
          });
          await new Promise(function(r) { setTimeout(r, 800); });
        } catch (e) {}
      }
    }
  }
  return true;
}

// ── Main message handler ────────────────────────────────────

async function handleMessage(sock, msg, clientId) {
  try {
    var jid        = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    var msgContent = msg.message || {};

    // ── Image receipt check — MUST be before anything else ──
    var isImage = !!(msgContent.imageMessage);
    if (isImage && isAwaitingReceipt(clientId, jid)) {
      await handleReceiptImage(sock, msg, clientId, jid);
      return;
    }

    var isVoice = !!(msgContent.audioMessage && msgContent.audioMessage.ptt);
    var isAudio = !!(msgContent.audioMessage);

    var text = (msgContent.conversation) ||
               (msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    // ── Voice note handling ─────────────────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'I received your voice note! Could you please type your message so I can help you faster? 😊'
      });
      return;
    }

    if (!text.trim()) return;

    // ── Get client ─────────────────────────────────────────
    var client = await db.getClientById(clientId);
    if (!client || client.status !== 'active' || !client.subscription_active) return;

    // ── Track customer ──────────────────────────────────────
    try {
      var sb = db.getSupabase();
      await sb.from('customers').upsert({
        client_id:    clientId,
        jid:          jid,
        last_contact: new Date().toISOString(),
        last_seen:    new Date().toISOString()
      }, { onConflict: 'client_id,jid', ignoreDuplicates: false });
    } catch (e) {}

    // ── Human pause check ───────────────────────────────────
    var pauseKey    = clientId + ':' + jid;
    var pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) return;
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff detection ─────────────────────────────
    if (wantsHuman(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Got it! I am connecting you with the owner right now. Please hold on 🙏'
      });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000);
      // notifyOwnerOfHandoff sends WhatsApp alert + push to owner
      await notifyOwnerOfHandoff(sock, clientId, jid, null, 'human_request').catch(function() {});
      return;
    }

    // ── Payment keyword detection ───────────────────────────
    // (asks customer to send receipt photo — owner confirms on dashboard)
    if (isPaymentKeyword(text)) {
      await handlePaymentClaim(sock, msg, clientId, jid, text);
      return;
    }

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    // ── Smart listings search ───────────────────────────────
    if (isListingQuery(text)) {
      var matches = await searchListings(clientId, text);
      if (matches.length > 0) {
        var sent = await sendListingResults(sock, jid, matches, client);
        if (sent) {
          // Notify owner of lead
          var names = matches.map(function(l) { return l.name; });
          notifyOwnerOfLead(clientId, jid, names).catch(function() {});
          return;
        }
      }
    }

    // ── Flow keyword matching ───────────────────────────────
    var flows   = await db.getFlows(clientId, true);
    var matched = null;
    for (var i = 0; i < flows.length; i++) {
      var flow     = flows[i];
      var kws      = flow.keywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
      var textLow  = text.toLowerCase();
      if (kws.some(function(kw) { return textLow.includes(kw); })) { matched = flow; break; }
    }

    if (matched) {
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(jid, { image: { url: matched.media_url }, caption: matched.response });
      } else {
        await sock.sendMessage(jid, { text: matched.response });
      }
      return;
    }

    // ── Broad search fallback ───────────────────────────────
    if (!isListingQuery(text)) {
      var broad = await searchListings(clientId, text);
      if (broad.length > 0) {
        var broadSent = await sendListingResults(sock, jid, broad, client);
        if (broadSent) {
          notifyOwnerOfLead(clientId, jid, broad.map(function(l) { return l.name; })).catch(function() {});
          return;
        }
      }
    }

    // ── Fallback message ────────────────────────────────────
    var fallback = client.fallback_message ||
      'Thank you for reaching out! Someone will get back to you shortly. 😊';
    await sock.sendMessage(jid, { text: fallback });

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
