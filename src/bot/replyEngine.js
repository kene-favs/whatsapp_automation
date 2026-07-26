// ============================================================
//  ForgeBot — replyEngine.js
//  File location: src/bot/replyEngine.js
// ============================================================
const db           = require('../db/supabase');
const { matchKeyword }           = require('./keywords');
const { transcribeVoiceNote }    = require('./voiceHandler');
const {
  isPaymentClaim,
  notifyOwnerOfPaymentClaim,
  handleOwnerReply,
  notifyOwnerHumanRequest
} = require('./paymentNotifier');

// Tracks customers paused for human handoff: key = clientId:jid, value = timestamp until paused
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
  const lower = text.toLowerCase();
  return HUMAN_HANDOFF_KEYWORDS.some(function(kw) { return lower.includes(kw); });
}

async function handleMessage(sock, msg, clientId) {
  try {
    const jid = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    const msgContent = msg.message;
    const isVoice = !!(msgContent && msgContent.audioMessage && msgContent.audioMessage.ptt);
    const isAudio = !!(msgContent && msgContent.audioMessage);

    let text = (msgContent && msgContent.conversation) ||
               (msgContent && msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent && msgContent.imageMessage && msgContent.imageMessage.caption) || '';

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

    if (!text.trim()) return;

    // ── Get client ──────────────────────────────────────────────────────────
    const client = await db.getClientById(clientId);

    // PATCHED: log why we skip instead of silently returning
    if (!client) {
      console.warn('[ReplyEngine] Client not found in DB: ' + clientId + ' — skipping message');
      return;
    }
    if (client.status !== 'active') {
      console.warn('[ReplyEngine] Client status is "' + client.status + '" (not "active") for ' + clientId + ' — skipping. Fix: UPDATE clients SET status=\'active\' WHERE id=\'' + clientId + '\'');
      return;
    }
    if (!client.subscription_active) {
      console.warn('[ReplyEngine] subscription_active is false for ' + clientId + ' — skipping. Fix: UPDATE clients SET subscription_active=true WHERE id=\'' + clientId + '\'');
      return;
    }

    // ── Check if this is the owner replying to a payment alert ─────────────
    const ownerHandled = await handleOwnerReply(sock, jid, text, clientId);
    if (ownerHandled) return;

    // ── Check if customer is paused (owner is handling them) ───────────────
    const pauseKey = clientId + ':' + jid;
    const pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) return;
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff detection ─────────────────────────────────────────────
    if (wantsHuman(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Got it! I am connecting you with the owner right now. Please hold on -- they will be with you shortly.'
      });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000); // pause 30 minutes
      await notifyOwnerHumanRequest(sock, clientId, jid);
      return;
    }

    // ── Payment claim detection ─────────────────────────────────────────────
    if (isPaymentClaim(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Thank you! Your payment claim has been received. The owner has been notified and will confirm shortly. We will update you right away!'
      });
      await notifyOwnerOfPaymentClaim(sock, clientId, jid, text);
      return;
    }

    // ── Flow keyword matching ───────────────────────────────────────────────
    const flows = await db.getFlows(clientId, true);
    let matched = null;
    for (const flow of flows) {
      const kws = flow.keywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
      const textLower = text.toLowerCase();
      if (kws.some(function(kw) { return textLower.includes(kw); })) {
        matched = flow;
        break;
      }
    }

    await sock.sendPresenceUpdate('composing', jid);
    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    if (matched) {
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(jid, { image: { url: matched.media_url }, caption: matched.response });
      } else {
        await sock.sendMessage(jid, { text: matched.response });
      }
    } else {
      const fallback = client.fallback_message ||
        'Thank you for reaching out! Someone will get back to you shortly.';
      await sock.sendMessage(jid, { text: fallback });
    }

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
