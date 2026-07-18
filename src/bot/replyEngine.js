// ============================================================
//  ForgeBot — Reply Engine v2
//  File location: src/bot/replyEngine.js
//
//  What's new in v2:
//   - Context-aware listing detection (tracks which listing
//     a conversation is about; media requests pull ONLY from
//     that specific listing — not random files)
//   - Images sent one by one (not dumped all at once)
//   - PDF / document sending
//   - Video sending
//   - Unlimited FAQ matching (checks business_faq table)
//   - Lead qualification per occupation (multi-step questions)
//   - Location sharing
//   - Partner / trial expiry check
//   - Lazy Supabase init (prevents Railway crash on boot)
//   - No apostrophes in single-quoted strings (syntax fix)
// ============================================================

'use strict';

const { createClient } = require('@supabase/supabase-js');
const db              = require('../db/supabase');
const { transcribeVoiceNote } = require('./voiceHandler');
const {
  isPaymentClaim,
  notifyOwnerOfPaymentClaim,
  handleOwnerReply,
  notifyOwnerHumanRequest
} = require('./paymentNotifier');

// ── Lazy Supabase init ────────────────────────────────────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('[ReplyEngine] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    }
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

// ── In-memory state maps ──────────────────────────────────────
const humanPaused       = new Map(); // `clientId:jid` → timestamp until paused
const conversationState = new Map(); // `clientId:jid` → state object

// State shape:
// {
//   stage: 'IDLE' | 'QUALIFYING' | 'LISTING_ACTIVE',
//   currentListingId: uuid | null,
//   currentListingName: string | null,
//   qualStep: number,
//   qualAnswers: [{key, question, answer}],
//   lastActivity: timestamp
// }

const STATE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes inactivity resets state

function getState(clientId, jid) {
  const key   = clientId + ':' + jid;
  const state = conversationState.get(key);
  if (!state) return freshState();
  if (Date.now() - state.lastActivity > STATE_TIMEOUT_MS) {
    conversationState.delete(key);
    return freshState();
  }
  return state;
}

function freshState() {
  return {
    stage: 'IDLE',
    currentListingId: null,
    currentListingName: null,
    qualStep: 0,
    qualAnswers: [],
    lastActivity: Date.now()
  };
}

function setState(clientId, jid, update) {
  const key     = clientId + ':' + jid;
  const current = getState(clientId, jid);
  conversationState.set(key, Object.assign({}, current, update, { lastActivity: Date.now() }));
}

// ── Helper: random human-like typing delay ────────────────────
function humanDelay() {
  return new Promise(function(r) { setTimeout(r, 1500 + Math.random() * 2000); });
}

function shortDelay() {
  return new Promise(function(r) { setTimeout(r, 800); });
}

// ── Keyword lists ─────────────────────────────────────────────

const HUMAN_KEYWORDS = [
  'speak to human', 'talk to human', 'real person', 'speak to someone',
  'talk to agent', 'connect me', 'i want to talk', 'speak to owner',
  'talk to owner', 'human please', 'abeg connect me', 'give me human',
  'i want owner', 'customer service', 'customer care', 'live agent',
  'actual person', 'not bot', 'no bot', 'human being', 'speak to agent'
];

const MEDIA_KEYWORDS = [
  'photo', 'picture', 'image', 'photos', 'pictures', 'images',
  'video', 'videos', 'clip', 'footage', 'show me', 'send me',
  'document', 'documents', 'brochure', 'catalogue', 'catalog',
  'pdf', 'file', 'files', 'send the', 'i want to see', 'let me see',
  'show the', 'send pic', 'send photo', 'send video', 'send document'
];

const LOCATION_KEYWORDS = [
  'location', 'where are you', 'address', 'where is', 'how to get',
  'direction', 'find you', 'office location', 'your address', 'come to',
  'visit you', 'where can i find', 'google map', 'map', 'locate you',
  'where do you', 'how do i get to', 'your office'
];

const QUALIFICATION_INTENT = [
  'i am interested', 'i want to', 'i need', 'looking for', 'i would like',
  "i'd like", 'i want to book', 'i want to order', 'i want to buy',
  'how do i proceed', 'how can i', 'can i order', 'can i book',
  'can i get', 'i would love', 'i am ready', 'ready to proceed',
  'lets proceed', "let's proceed", 'what do i need to do'
];

// ── Lead qualification questions per occupation ───────────────
const QUAL_QUESTIONS = {
  real_estate: [
    { key: 'purpose',  q: 'Are you looking to *buy* or *rent*?' },
    { key: 'budget',   q: 'What is your budget range?' },
    { key: 'area',     q: 'Which area or location are you most interested in?' },
    { key: 'timeline', q: 'When are you looking to make a decision?' }
  ],
  photography: [
    { key: 'event_type',  q: 'What type of shoot or event do you need covered?' },
    { key: 'event_date',  q: 'What is the date of your event?' },
    { key: 'location',    q: 'Where will the event take place?' },
    { key: 'guest_count', q: 'Approximately how many guests or subjects?' }
  ],
  medical: [
    { key: 'service',  q: 'What medical service or consultation do you need?' },
    { key: 'urgency',  q: 'Is this urgent or can it be scheduled for a later date?' },
    { key: 'for_who',  q: 'Is this for an adult or a child?' }
  ],
  legal: [
    { key: 'case_type', q: 'What area of law does your matter involve? (e.g. property, family, corporate)' },
    { key: 'timeline',  q: 'How soon do you need legal assistance?' },
    { key: 'location',  q: 'Which state is this matter based in?' }
  ],
  consulting: [
    { key: 'problem',       q: 'What specific challenge or goal do you need help with?' },
    { key: 'company_size',  q: 'Is this for an individual, a small business, or a larger company?' },
    { key: 'budget',        q: 'Do you have a rough budget in mind for this engagement?' }
  ],
  fashion: [
    { key: 'outfit_type', q: 'What type of outfit are you looking to make or buy?' },
    { key: 'occasion',    q: 'What is the occasion or event for this outfit?' },
    { key: 'timeline',    q: 'When do you need it ready?' },
    { key: 'budget',      q: 'What is your budget?' }
  ],
  beauty: [
    { key: 'service',      q: 'Which beauty service are you interested in?' },
    { key: 'date',         q: 'When would you like your appointment?' },
    { key: 'home_service', q: 'Do you prefer to come to us or do you need a home service?' }
  ],
  food: [
    { key: 'order_type', q: 'Are you ordering for personal delivery or for an event / catering?' },
    { key: 'quantity',   q: 'Roughly how many portions, or what is the event size?' },
    { key: 'date',       q: 'When do you need this?' }
  ],
  logistics: [
    { key: 'package_type', q: 'What are you sending? (documents, packages, bulk goods)' },
    { key: 'pickup',       q: 'What is the pickup location?' },
    { key: 'destination',  q: 'Where is it going to?' },
    { key: 'weight',       q: 'What is the approximate weight or size?' }
  ],
  education: [
    { key: 'subject', q: 'Which subject or course are you interested in?' },
    { key: 'level',   q: 'What level is the student? (Primary, Secondary, University, Adult)' },
    { key: 'mode',    q: 'Do you prefer physical classes or online learning?' }
  ],
  events: [
    { key: 'event_type', q: 'What type of event are you planning?' },
    { key: 'date',       q: 'What is the proposed event date?' },
    { key: 'guests',     q: 'How many guests are you expecting?' },
    { key: 'budget',     q: 'What is your event budget?' }
  ],
  tech: [
    { key: 'service',  q: 'What tech service do you need? (website, mobile app, IT support, etc.)' },
    { key: 'timeline', q: 'What is your project timeline?' },
    { key: 'budget',   q: 'Do you have a budget in mind?' }
  ],
  auto: [
    { key: 'interest', q: 'Are you looking to *buy a vehicle* or need *repair / service*?' },
    { key: 'type',     q: 'What type of vehicle are you interested in? (sedan, SUV, truck, etc.)' },
    { key: 'budget',   q: 'What is your budget range?' }
  ],
  agriculture: [
    { key: 'product',  q: 'Which product are you interested in purchasing?' },
    { key: 'quantity', q: 'What quantity do you need?' },
    { key: 'delivery', q: 'Do you need delivery or will you arrange your own pickup?' }
  ],
  travel: [
    { key: 'destination', q: 'Where would you like to travel to?' },
    { key: 'dates',       q: 'What are your preferred travel dates?' },
    { key: 'travelers',   q: 'How many people will be traveling?' },
    { key: 'budget',      q: 'What is your total budget?' }
  ],
  fitness: [
    { key: 'goal',       q: 'What is your fitness goal? (weight loss, muscle building, general fitness)' },
    { key: 'experience', q: 'What is your current fitness level?' },
    { key: 'mode',       q: 'Do you prefer gym sessions, home training, or online coaching?' }
  ],
  interior: [
    { key: 'project',  q: 'What type of project is this? (home, office, event space)' },
    { key: 'rooms',    q: 'How many rooms or what area needs to be designed?' },
    { key: 'budget',   q: 'What is your approximate budget?' },
    { key: 'timeline', q: 'When do you need the project completed?' }
  ],
  general: [
    { key: 'need',     q: 'Can you tell me more about exactly what you need?' },
    { key: 'timeline', q: 'When do you need this done by?' },
    { key: 'budget',   q: 'Do you have a budget in mind?' }
  ]
};

// ── Helper: check if text contains any keyword ────────────────
function matchesAny(text, keywords) {
  var lower = text.toLowerCase();
  return keywords.some(function(kw) { return lower.includes(kw); });
}

// ── Helper: check if text matches keyword CSV ─────────────────
// Returns true if ANY keyword in a comma-separated list is found
function matchesCSV(text, csvKeywords) {
  if (!csvKeywords) return false;
  var lower = text.toLowerCase();
  var kws   = csvKeywords.split(',').map(function(k) { return k.trim().toLowerCase(); });
  return kws.some(function(kw) { return kw && lower.includes(kw); });
}

// ── Helper: fuzzy word overlap for FAQ matching ───────────────
// Returns true if >= 40% of the words in the question appear in text
function fuzzyMatch(text, question) {
  var textWords = text.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 2; });
  var qWords    = question.toLowerCase().split(/\s+/).filter(function(w) { return w.length > 2; });
  if (!qWords.length) return false;
  var matches = qWords.filter(function(w) { return textWords.includes(w); }).length;
  return matches / qWords.length >= 0.4;
}

// ── Match FAQ: check business_faq table ──────────────────────
async function matchFAQ(clientId, text) {
  try {
    var supabase = getSupabase();
    var result   = await supabase
      .from('business_faq')
      .select('question,answer,keywords')
      .eq('client_id', clientId)
      .order('sort_order', { ascending: true });

    if (result.error || !result.data || !result.data.length) return null;

    for (var i = 0; i < result.data.length; i++) {
      var faq = result.data[i];
      if (matchesCSV(text, faq.keywords)) return faq.answer;
      if (fuzzyMatch(text, faq.question)) return faq.answer;
    }
    return null;
  } catch (e) {
    console.error('[ReplyEngine] FAQ match error:', e.message);
    return null;
  }
}

// ── Find listing matching message ─────────────────────────────
async function findListing(clientId, text) {
  try {
    var supabase = getSupabase();
    var result   = await supabase
      .from('service_listings')
      .select('id,name,description,price,price_label,location,keywords')
      .eq('client_id', clientId)
      .eq('available', true);

    if (result.error || !result.data || !result.data.length) return null;

    for (var i = 0; i < result.data.length; i++) {
      var listing = result.data[i];
      if (matchesCSV(text, listing.keywords)) return listing;
    }
    return null;
  } catch (e) {
    console.error('[ReplyEngine] Listing match error:', e.message);
    return null;
  }
}

// ── Fetch media for a listing ─────────────────────────────────
async function getListingMedia(listingId, mediaType) {
  try {
    var supabase = getSupabase();
    var query    = supabase
      .from('listing_media')
      .select('id,media_type,url,filename,caption,sort_order')
      .eq('listing_id', listingId)
      .order('sort_order', { ascending: true });

    if (mediaType) query = query.eq('media_type', mediaType);

    var result = await query;
    return (result.error || !result.data) ? [] : result.data;
  } catch (e) {
    console.error('[ReplyEngine] Media fetch error:', e.message);
    return [];
  }
}

// ── Build listing info text ───────────────────────────────────
function buildListingText(listing) {
  var lines = [];
  lines.push('*' + listing.name + '*');
  if (listing.location)    lines.push('📍 ' + listing.location);
  if (listing.price_label) lines.push('💰 ' + listing.price_label);
  else if (listing.price)  lines.push('💰 ₦' + Number(listing.price).toLocaleString());
  if (listing.description) lines.push('\n' + listing.description);
  return lines.join('\n');
}

// ── Send media files for a listing ───────────────────────────
async function sendListingMedia(sock, jid, listingId, requestedType) {
  var all     = await getListingMedia(listingId, null);
  var images  = all.filter(function(m) { return m.media_type === 'image'; });
  var videos  = all.filter(function(m) { return m.media_type === 'video'; });
  var docs    = all.filter(function(m) { return m.media_type === 'document'; });

  // Decide what to send based on request
  var toSend  = all;
  if (requestedType === 'image')    toSend = images;
  if (requestedType === 'video')    toSend = videos;
  if (requestedType === 'document') toSend = docs;

  if (!toSend.length) {
    await sock.sendMessage(jid, { text: 'No media files have been uploaded for this yet. Please ask the owner directly.' });
    return;
  }

  for (var i = 0; i < toSend.length; i++) {
    var item = toSend[i];
    try {
      if (item.media_type === 'image') {
        await sock.sendMessage(jid, {
          image: { url: item.url },
          caption: item.caption || ''
        });
      } else if (item.media_type === 'video') {
        await sock.sendMessage(jid, {
          video: { url: item.url },
          caption: item.caption || ''
        });
      } else if (item.media_type === 'document') {
        await sock.sendMessage(jid, {
          document: { url: item.url },
          mimetype: 'application/pdf',
          fileName: item.filename || 'document.pdf',
          caption: item.caption || ''
        });
      }
      // Small delay between files so WhatsApp does not throttle
      if (i < toSend.length - 1) await shortDelay();
    } catch (e) {
      console.error('[ReplyEngine] Media send error:', e.message);
    }
  }
}

// ── Detect what type of media is being requested ─────────────
function detectMediaType(text) {
  var lower = text.toLowerCase();
  if (lower.includes('video') || lower.includes('clip') || lower.includes('footage')) return 'video';
  if (lower.includes('document') || lower.includes('brochure') || lower.includes('pdf') ||
      lower.includes('catalogue') || lower.includes('catalog') || lower.includes('file')) return 'document';
  return 'image'; // default to images
}

// ── Format qualification summary for owner ────────────────────
function buildQualSummary(listing, answers, jid) {
  var phone = jid.replace('@s.whatsapp.net', '');
  var lines = [];
  lines.push('🔔 *New Qualified Lead*');
  lines.push('Customer: wa.me/' + phone);
  if (listing) lines.push('Interested in: ' + listing);
  lines.push('');
  lines.push('*Their answers:*');
  for (var i = 0; i < answers.length; i++) {
    lines.push('• ' + answers[i].question + '\n  → ' + answers[i].answer);
  }
  lines.push('\nReply to this number to follow up!');
  return lines.join('\n');
}

// ── Main message handler ──────────────────────────────────────
async function handleMessage(sock, msg, clientId) {
  try {
    var jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    var msgContent = msg.message;
    var isVoice    = !!(msgContent && msgContent.audioMessage && msgContent.audioMessage.ptt);
    var isAudio    = !!(msgContent && msgContent.audioMessage);

    var text = (msgContent && msgContent.conversation) ||
               (msgContent && msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent && msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    // ── Voice note transcription ───────────────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      var transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(jid, {
          text: 'I received your voice note! Please type your message so I can help you faster.'
        });
        return;
      }
      text = transcribed;
      await sock.sendMessage(jid, {
        text: 'I heard: _"' + transcribed + '"_\n\nLet me help you with that...'
      });
    }

    if (!text || !text.trim()) return;

    // ── Get client — check active + subscription ────────────────
    var client = await db.getClientById(clientId);
    if (!client || client.status !== 'active' || !client.subscription_active) return;

    // ── Check owner reply (payment handler) ────────────────────
    var ownerHandled = await handleOwnerReply(sock, jid, text, clientId);
    if (ownerHandled) return;

    // ── Check if conversation is paused for human ──────────────
    var pauseKey    = clientId + ':' + jid;
    var pausedUntil = humanPaused.get(pauseKey);
    if (pausedUntil && Date.now() < pausedUntil) return;
    if (pausedUntil && Date.now() >= pausedUntil) humanPaused.delete(pauseKey);

    // ── Human handoff detection ────────────────────────────────
    if (matchesAny(text, HUMAN_KEYWORDS)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Got it! I am connecting you with the owner right now. Please hold on -- they will be with you shortly.'
      });
      humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000);
      await notifyOwnerHumanRequest(sock, clientId, jid);
      return;
    }

    // ── Payment claim detection ────────────────────────────────
    if (isPaymentClaim(text)) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: 'Thank you! Your payment has been received and noted. The owner has been notified and will confirm it shortly. We will update you right away!'
      });
      await notifyOwnerOfPaymentClaim(sock, clientId, jid, text);
      return;
    }

    // ── Load conversation state ────────────────────────────────
    var state      = getState(clientId, jid);
    var occupation = client.occupation || 'general';
    var occData    = client.occupation_data || {};

    await sock.sendPresenceUpdate('composing', jid);

    // ── QUALIFYING stage: collect next answer ──────────────────
    if (state.stage === 'QUALIFYING') {
      var questions = QUAL_QUESTIONS[occupation] || QUAL_QUESTIONS['general'];
      var step      = state.qualStep;

      // Store the answer to the question we just asked
      var answeredQ = questions[step - 1];
      if (answeredQ) {
        state.qualAnswers.push({
          key:      answeredQ.key,
          question: answeredQ.q.replace(/\*/g, ''),
          answer:   text.trim()
        });
      }

      // Ask next question OR finish
      if (step < questions.length) {
        setState(clientId, jid, {
          stage:       'QUALIFYING',
          qualStep:    step + 1,
          qualAnswers: state.qualAnswers
        });
        await humanDelay();
        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, { text: questions[step].q });
        return;
      } else {
        // All questions answered — send summary to owner
        setState(clientId, jid, { stage: 'IDLE', qualStep: 0, qualAnswers: [] });
        await humanDelay();
        await sock.sendPresenceUpdate('paused', jid);
        await sock.sendMessage(jid, {
          text: 'Thank you! I have noted all your details. The owner will be in touch with you shortly to discuss next steps.'
        });
        // Notify owner
        if (client.notification_number) {
          var ownerJid = client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net';
          var summary  = buildQualSummary(state.currentListingName, state.qualAnswers, jid);
          try {
            await sock.sendMessage(ownerJid, { text: summary });
          } catch (e) {
            console.error('[ReplyEngine] Could not notify owner of lead:', e.message);
          }
        }
        // Pause bot for 30 min so owner can reply
        humanPaused.set(pauseKey, Date.now() + 30 * 60 * 1000);
        return;
      }
    }

    // ── Media request (photos/videos/documents) ────────────────
    if (matchesAny(text, MEDIA_KEYWORDS)) {
      await humanDelay();
      await sock.sendPresenceUpdate('paused', jid);

      if (state.currentListingId) {
        var mediaType = detectMediaType(text);
        await sendListingMedia(sock, jid, state.currentListingId, mediaType);
      } else {
        // No active listing — ask which one they mean
        var plural = occupation === 'real_estate' ? 'property' : 'listing';
        await sock.sendMessage(jid, {
          text: 'Which ' + plural + ' are you asking about? Please mention the name or location and I will send the media for that specific one.'
        });
      }
      return;
    }

    // ── Location request ───────────────────────────────────────
    if (matchesAny(text, LOCATION_KEYWORDS)) {
      await humanDelay();
      await sock.sendPresenceUpdate('paused', jid);
      if (client.location_address) {
        var locText = '📍 *Our Location*\n' + client.location_address;
        if (client.location_maps_url) locText += '\n\n🗺 Google Maps: ' + client.location_maps_url;
        await sock.sendMessage(jid, { text: locText });
      } else {
        await sock.sendMessage(jid, {
          text: 'Please contact the owner directly for our exact location details.'
        });
      }
      return;
    }

    // ── Listing / property / package detection ─────────────────
    var matchedListing = await findListing(clientId, text);
    if (matchedListing) {
      setState(clientId, jid, {
        stage:            'LISTING_ACTIVE',
        currentListingId: matchedListing.id,
        currentListingName: matchedListing.name
      });

      var listingText = buildListingText(matchedListing);

      // Check if there is media available for this listing
      var allMedia = await getListingMedia(matchedListing.id, null);
      var imgCount = allMedia.filter(function(m) { return m.media_type === 'image'; }).length;
      var vidCount = allMedia.filter(function(m) { return m.media_type === 'video'; }).length;
      var docCount = allMedia.filter(function(m) { return m.media_type === 'document'; }).length;

      var mediaTip = [];
      if (imgCount) mediaTip.push(imgCount + ' photo' + (imgCount > 1 ? 's' : ''));
      if (vidCount) mediaTip.push(vidCount + ' video' + (vidCount > 1 ? 's' : ''));
      if (docCount) mediaTip.push(docCount + ' document' + (docCount > 1 ? 's' : ''));

      if (mediaTip.length) {
        listingText += '\n\n📎 I have ' + mediaTip.join(', ') + ' for this. Type *"photos"*, *"video"* or *"document"* to receive them.';
      }

      await humanDelay();
      await sock.sendPresenceUpdate('paused', jid);
      await sock.sendMessage(jid, { text: listingText });

      // Trigger qualification if enabled
      if (occData.qualification_enabled) {
        var qualQs = QUAL_QUESTIONS[occupation] || QUAL_QUESTIONS['general'];
        if (qualQs && qualQs.length) {
          await shortDelay();
          setState(clientId, jid, { stage: 'QUALIFYING', qualStep: 1, qualAnswers: [] });
          await sock.sendMessage(jid, { text: 'To help you better, I have a few quick questions:\n\n' + qualQs[0].q });
        }
      }
      return;
    }

    await sock.sendPresenceUpdate('paused', jid);

    // ── FAQ matching ───────────────────────────────────────────
    var faqAnswer = await matchFAQ(clientId, text);
    if (faqAnswer) {
      await humanDelay();
      await sock.sendMessage(jid, { text: faqAnswer });
      return;
    }

    // ── Qualification intent (without a specific listing) ──────
    if (occData.qualification_enabled && matchesAny(text, QUALIFICATION_INTENT)) {
      var qQuestions = QUAL_QUESTIONS[occupation] || QUAL_QUESTIONS['general'];
      if (qQuestions && qQuestions.length) {
        setState(clientId, jid, { stage: 'QUALIFYING', qualStep: 1, qualAnswers: [] });
        await humanDelay();
        await sock.sendMessage(jid, {
          text: 'Great! To make sure we can help you properly, I have a few quick questions:\n\n' + qQuestions[0].q
        });
        return;
      }
    }

    // ── Existing auto-reply flows ──────────────────────────────
    var flows   = await db.getFlows(clientId, true);
    var matched = null;
    for (var fi = 0; fi < flows.length; fi++) {
      if (matchesCSV(text, flows[fi].keywords)) {
        matched = flows[fi];
        break;
      }
    }

    await humanDelay();

    if (matched) {
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(jid, {
          image: { url: matched.media_url },
          caption: matched.response || ''
        });
      } else if (matched.response_type === 'document' && matched.media_url) {
        await sock.sendMessage(jid, {
          document: { url: matched.media_url },
          mimetype: 'application/pdf',
          fileName: 'document.pdf',
          caption: matched.response || ''
        });
      } else if (matched.response_type === 'video' && matched.media_url) {
        await sock.sendMessage(jid, {
          video: { url: matched.media_url },
          caption: matched.response || ''
        });
      } else {
        await sock.sendMessage(jid, { text: matched.response });
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
