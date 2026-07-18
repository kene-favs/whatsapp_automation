// ============================================================
//  ForgeBot — Smart Reply Engine
//  File: src/bot/replyEngine.js
//
//  State machine conversation engine. No OpenAI needed.
//  Integrates with existing db, voiceHandler and paymentNotifier.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const db = require('../db/supabase');                           // existing module
const { transcribeVoiceNote } = require('./voiceHandler');      // existing module
const {
  isPaymentClaim,
  notifyOwnerOfPaymentClaim,
  handleOwnerReply,
  notifyOwnerHumanRequest
} = require('./paymentNotifier');                               // existing module

// ── Supabase client for new tables (products, orders, etc.) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Conversation state machine ────────────────────────────────
const STATE = {
  GREETING:        'GREETING',
  AWAITING_NAME:   'AWAITING_NAME',
  BROWSING:        'BROWSING',
  ORDERING:        'ORDERING',
  AWAITING_ADDRESS:'AWAITING_ADDRESS',
  AWAITING_APPT:   'AWAITING_APPT',
  AWAITING_RECEIPT:'AWAITING_RECEIPT',
  HUMAN_PAUSED:    'HUMAN_PAUSED'
};

// key: "clientId:jid" → { state, customerName, cart[], orderId, lastMsg }
const convStates = new Map();

function getState(clientId, jid) {
  return convStates.get(clientId + ':' + jid) || { state: STATE.GREETING, cart: [] };
}
function setState(clientId, jid, data) {
  const key = clientId + ':' + jid;
  convStates.set(key, { ...getState(clientId, jid), ...data });
}
function clearState(clientId, jid) {
  convStates.delete(clientId + ':' + jid);
}

// ── Intent keyword detection ──────────────────────────────────
const INTENTS = {
  CATALOG:    ['catalog','catalogue','products','what do you have','what you have','show me','menu','list','what do you sell','your items','your products','your services','price list'],
  PRICE:      ['how much','price','cost','fee','rate','amount','naira','₦','how much is','what is the price','cost of'],
  ORDER:      ['i want','order','buy','purchase','get','i need','i'll take','i will take','send me','place order','i go buy'],
  MORE_ITEMS: ['add','also','and','more','another','plus','i also want','i need more'],
  DONE_ORDER: ['that is all','that\'s all','done','finish','checkout','i am done','nothing else','no more','that\'s it','thats it','complete order'],
  DELIVERY:   ['deliver','delivery','shipping','ship','how long','when will','location','where are you','your address','office','pickup'],
  HOURS:      ['open','close','hours','time','when','available','working hours','office hours','what time'],
  SOCIAL:     ['instagram','facebook','tiktok','twitter','youtube','social','follow','page','channel','whatsapp channel'],
  PAYMENT_Q:  ['account','bank','how do i pay','payment','transfer','how to pay','account number','account name','your bank'],
  COMPLAINT:  ['complain','complaint','bad','wrong','issue','problem','not happy','disappointed','rubbish','terrible'],
  RETURN:     ['return','refund','exchange','send back','wrong item','not what i','damaged'],
  BULK:       ['bulk','wholesale','many','large order','50','100','large quantity','discount for'],
  REFERRAL:   ['refer','referral','bring friend','commission','reward'],
  PROMO:      ['promo','discount','sale','offer','deal','coupon','special'],
  HUMAN:      ['speak to human','talk to human','real person','speak to someone','talk to agent','connect me','speak to owner','talk to owner','human please','abeg connect me','give me human','i want owner','customer service','customer care','live agent','actual person','not bot','no bot','human being'],
  PAYMENT_CLAIM: ['i have paid','i paid','payment done','sent','transferred','i sent','i transfer','see alert','check your account','paid already'],
  GREETING_W: ['hi','hello','hey','good morning','good afternoon','good evening','good night','sup','holla','oga','how far'],
  THANKS:     ['thank','thanks','thank you','okay','ok','noted','alright','cool','nice','great','wonderful','perfect']
};

function detect(text) {
  const lower = text.toLowerCase();
  for (const [intent, keywords] of Object.entries(INTENTS)) {
    if (keywords.some(k => lower.includes(k))) return intent;
  }
  return null;
}

// ── Fuzzy product/service name match (60% word overlap) ───────
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}

function findItem(text, items) {
  const queryWords = normalize(text);
  let best = null, bestScore = 0;
  for (const item of items) {
    const nameWords = normalize(item.name);
    const matches = queryWords.filter(w => nameWords.some(n => n.includes(w) || w.includes(n)));
    const score = matches.length / Math.max(queryWords.length, nameWords.length);
    if (score > bestScore && score >= 0.4) { bestScore = score; best = item; }
  }
  return best;
}

// ── Time-based greeting ───────────────────────────────────────
function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ── Format price ──────────────────────────────────────────────
function fmt(num) { return '₦' + Number(num).toLocaleString('en-NG'); }

// ── Human delay (realistic typing simulation) ─────────────────
function humanDelay() { return new Promise(r => setTimeout(r, 1000 + Math.random() * 1500)); }

// ── Send a push notification to the business owner ────────────
async function pushOwner(clientId, title, body, url) {
  try {
    if (typeof global.getSock === 'function') {
      // routes.js exports pushToClient — use it if available
      const routes = require('../../routes');
      if (routes && routes.pushToClient) {
        await routes.pushToClient(clientId, title, body, url);
      }
    }
  } catch (_) { /* push is non-critical */ }
}

// ── Build bank transfer message ───────────────────────────────
function buildAccountMsg(client) {
  if (!client.bank_name && !client.account_number) return null;
  return `💳 *Payment Details*\n` +
    `Bank: *${client.bank_name || 'N/A'}*\n` +
    `Account Number: *${client.account_number || 'N/A'}*\n` +
    `Account Name: *${client.account_name || 'N/A'}*\n\n` +
    `After payment, please send your *receipt/screenshot* here so we can confirm. 🙏`;
}

// ── Save receipt image to Supabase Storage ────────────────────
async function saveReceiptImage(sock, msg, clientId, jid) {
  try {
    const imgMsg = msg.message.imageMessage;
    if (!imgMsg) return null;

    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: { error: ()=>{}, warn: ()=>{}, info: ()=>{} } });

    const filename = `receipts/${clientId}/${Date.now()}.jpg`;
    const { error } = await supabase.storage
      .from('forgebot-receipts')
      .upload(filename, buffer, { contentType: 'image/jpeg', upsert: false });

    if (error) throw error;
    const { data } = supabase.storage.from('forgebot-receipts').getPublicUrl(filename);
    return data.publicUrl;
  } catch (e) {
    console.error('[ReplyEngine] Receipt upload failed:', e.message);
    return null;
  }
}

// ── Get or create customer record ─────────────────────────────
async function getOrCreateCustomer(clientId, jid, name) {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('client_id', clientId)
    .eq('jid', jid)
    .single();

  if (data) {
    // Update last contact
    await supabase.from('customers').update({ last_contact: new Date().toISOString(), name: name || data.name }).eq('id', data.id);
    return data;
  }

  // New customer
  const { data: newCust } = await supabase
    .from('customers')
    .insert({ client_id: clientId, jid, name: name || null, phone: jid.replace('@s.whatsapp.net','') })
    .select().single();
  return newCust;
}

// ── Get catalog (products + services based on business type) ──
async function getCatalog(clientId, businessType) {
  const items = [];

  if (businessType === 'products' || businessType === 'both') {
    const { data } = await supabase.from('products').select('*').eq('client_id', clientId).eq('in_stock', true);
    (data || []).forEach(p => items.push({ ...p, _type: 'product' }));
  }

  if (businessType === 'services' || businessType === 'both') {
    const { data } = await supabase.from('services').select('*').eq('client_id', clientId).eq('available', true);
    (data || []).forEach(s => items.push({ ...s, _type: 'service' }));
  }

  return items;
}

// ── Build catalog message ─────────────────────────────────────
function buildCatalogMsg(items, businessName) {
  if (!items.length) return `We are currently updating our catalog. Please check back soon! 😊`;

  let msg = `🛍️ *${businessName} — Our Catalog*\n\n`;
  const products = items.filter(i => i._type === 'product');
  const services = items.filter(i => i._type === 'service');

  if (products.length) {
    msg += `📦 *Products*\n`;
    products.forEach((p, i) => {
      msg += `${i + 1}. *${p.name}* — ${fmt(p.price)}\n`;
      if (p.description) msg += `   _${p.description}_\n`;
    });
    msg += '\n';
  }

  if (services.length) {
    msg += `✨ *Services*\n`;
    services.forEach((s, i) => {
      msg += `${i + 1}. *${s.name}* — ${fmt(s.price)}\n`;
      if (s.duration) msg += `   ⏱️ ${s.duration}\n`;
      if (s.description) msg += `   _${s.description}_\n`;
    });
    msg += '\n';
  }

  msg += `To order, just tell me what you want! 😊`;
  return msg;
}

// ── Check custom Q&A from bot_setup ──────────────────────────
async function matchCustomQA(text, clientId) {
  const { data: setup } = await supabase
    .from('bot_setup')
    .select('custom_service_1_q,custom_service_1_a,custom_service_2_q,custom_service_2_a,custom_service_3_q,custom_service_3_a')
    .eq('client_id', clientId)
    .single();

  if (!setup) return null;

  const pairs = [
    [setup.custom_service_1_q, setup.custom_service_1_a],
    [setup.custom_service_2_q, setup.custom_service_2_a],
    [setup.custom_service_3_q, setup.custom_service_3_a]
  ].filter(([q, a]) => q && a);

  const queryWords = normalize(text);
  for (const [question, answer] of pairs) {
    const qWords = normalize(question);
    const matches = queryWords.filter(w => qWords.some(q => q.includes(w) || w.includes(q)));
    const score = matches.length / Math.max(queryWords.length, qWords.length);
    if (score >= 0.5) return answer;
  }
  return null;
}

// ── Alert owner of new order via WhatsApp + push ──────────────
async function alertOwnerNewOrder(sock, client, order, customerName) {
  try {
    const appUrl = process.env.APP_URL || 'https://yourapp.railway.app';
    const dashUrl = `${appUrl}/dashboard?token=${client.token || ''}`;

    const itemList = order.items.map(i => `• ${i.name} × ${i.qty} — ${fmt(i.price * i.qty)}`).join('\n');
    const msg = `🛒 *New Order — ${client.business_name}*\n\n` +
      `👤 Customer: *${customerName}*\n` +
      `📦 Items:\n${itemList}\n` +
      `💰 Total: *${fmt(order.total)}*\n\n` +
      `Reply *1* to confirm payment ✅\n` +
      `Reply *2* to reject ❌\n\n` +
      `👉 *View order:* ${dashUrl}`;

    const ownerJid = client.notification_number
      ? client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net'
      : null;

    if (ownerJid && sock) {
      await sock.sendMessage(ownerJid, { text: msg });
    }

    // Push notification to phone home screen
    await pushOwner(client.id, `🛒 New Order — ${customerName}`, `${fmt(order.total)} · ${order.items.length} item(s)`, dashUrl);
  } catch (e) {
    console.error('[ReplyEngine] Owner alert failed:', e.message);
  }
}

// ── Alert owner of price inquiry ──────────────────────────────
async function alertOwnerPriceInquiry(sock, client, customerName, itemName, price) {
  try {
    const appUrl = process.env.APP_URL || 'https://yourapp.railway.app';
    const dashUrl = `${appUrl}/dashboard?token=${client.token || ''}`;
    const msg = `👀 *Price Inquiry* — ${client.business_name}\n` +
      `*${customerName}* just asked about *${itemName}* (${fmt(price)})\n\n` +
      `👉 ${dashUrl}`;

    const ownerJid = client.notification_number
      ? client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net'
      : null;

    if (ownerJid && sock) await sock.sendMessage(ownerJid, { text: msg });

    await pushOwner(client.id, `👀 ${customerName} asked about ${itemName}`, `Price: ${fmt(price)}`, dashUrl);
  } catch (_) {}
}

// ── Handle owner's 1/2 payment reply ─────────────────────────
async function handleOwnerPaymentReply(sock, text, clientId) {
  const t = text.trim();
  if (t !== '1' && t !== '2') return false;

  // Find the most recent unpaid order for this client
  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .eq('client_id', clientId)
    .eq('payment_status', 'unpaid')
    .not('receipt_url', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (!orders || !orders.length) return false;

  const order = orders[0];
  const confirmed = t === '1';

  await supabase.from('orders').update({
    payment_status: confirmed ? 'confirmed' : 'rejected',
    status:         confirmed ? 'accepted'  : 'pending',
    updated_at:     new Date().toISOString()
  }).eq('id', order.id);

  const customerMsg = confirmed
    ? '✅ Your payment has been *confirmed*! Your order is now being processed. We will keep you updated. Thank you! 🙏'
    : '❌ We could not verify your payment. Please resend a *clear screenshot* of your bank transfer or contact us directly.';

  if (sock) await sock.sendMessage(order.customer_jid, { text: customerMsg });
  return true;
}

// ============================================================
//  MAIN MESSAGE HANDLER
// ============================================================
async function handleMessage(sock, msg, clientId) {
  try {
    const jid = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    const msgContent = msg.message;
    const isVoice = !!(msgContent?.audioMessage?.ptt);
    const isAudio = !!(msgContent?.audioMessage);
    const isImage = !!(msgContent?.imageMessage);

    let text = msgContent?.conversation ||
               msgContent?.extendedTextMessage?.text ||
               msgContent?.imageMessage?.caption || '';

    // ── Get client from existing DB ─────────────────────────
    const client = await db.getClientById(clientId);
    if (!client || client.status !== 'active') return;

    // ── Check if owner is replying (existing paymentNotifier) ─
    const ownerHandled = await handleOwnerReply(sock, jid, text, clientId);
    if (ownerHandled) return;

    // ── Also check for owner's 1/2 payment reply ────────────
    const ownerPayment = await handleOwnerPaymentReply(sock, text, clientId);
    if (ownerPayment) return;

    // ── Get bot_setup for this client ───────────────────────
    const { data: setup } = await supabase
      .from('bot_setup')
      .select('*')
      .eq('client_id', clientId)
      .single();

    const bizType = client.business_type || 'products';

    // ── Load conversation state ──────────────────────────────
    let conv = getState(clientId, jid);

    // ── Handle image (could be receipt) ─────────────────────
    if (isImage) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();

      if (conv.state === STATE.AWAITING_RECEIPT && conv.orderId) {
        // Save receipt and link to order
        const receiptUrl = await saveReceiptImage(sock, msg, clientId, jid);

        if (receiptUrl) {
          await supabase.from('orders').update({ receipt_url: receiptUrl }).eq('id', conv.orderId);

          await sock.sendMessage(jid, {
            text: '✅ Thank you! Your receipt has been received. The owner will confirm your payment shortly. We will notify you right away! 🙏'
          });

          // Alert owner
          await alertOwnerNewOrder(sock, client, { ...conv.orderData, id: conv.orderId }, conv.customerName || 'Customer');
          setState(clientId, jid, { state: STATE.BROWSING });
        } else {
          await sock.sendMessage(jid, { text: 'Sorry, I could not receive that image clearly. Please try again or send a clearer screenshot. 📸' });
        }
        return;
      }

      // If image comes in but not expecting receipt — treat as general
      if (!text.trim()) {
        await sock.sendMessage(jid, { text: 'Thanks for the image! How can I help you? 😊' });
        return;
      }
    }

    // ── Voice note handling ──────────────────────────────────
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      const transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(jid, { text: 'I received your voice note! Could you please *type your message* so I can help you faster? 😊' });
        return;
      }
      text = transcribed;
      await sock.sendMessage(jid, { text: `I heard: _"${transcribed}"_\n\nLet me help you with that...` });
    }

    if (!text.trim()) return;

    await sock.sendPresenceUpdate('composing', jid);

    // ── Human handoff check (always active) ─────────────────
    if (conv.state !== STATE.HUMAN_PAUSED) {
      const intent = detect(text);
      if (intent === 'HUMAN') {
        await humanDelay();
        await sock.sendMessage(jid, {
          text: 'Got it! I am connecting you with the owner right now. Please hold on — they will be with you shortly. 🙏'
        });
        setState(clientId, jid, { state: STATE.HUMAN_PAUSED, pausedUntil: Date.now() + 30 * 60 * 1000 });
        await notifyOwnerHumanRequest(sock, clientId, jid);
        return;
      }
    }

    // ── Human paused — check if expired ─────────────────────
    if (conv.state === STATE.HUMAN_PAUSED) {
      if (conv.pausedUntil && Date.now() < conv.pausedUntil) return; // still paused
      setState(clientId, jid, { state: STATE.BROWSING }); // auto-resume after 30 min
      conv = getState(clientId, jid);
    }

    // ── STATE: GREETING → check if known customer ────────────
    if (conv.state === STATE.GREETING) {
      const existing = await getOrCreateCustomer(clientId, jid, null);
      if (existing && existing.name) {
        // Returning customer — skip name capture
        setState(clientId, jid, { state: STATE.BROWSING, customerName: existing.name });
        conv = getState(clientId, jid);
        await humanDelay();
        await sock.sendMessage(jid, {
          text: `${timeGreeting()} *${existing.name}*! 👋 Welcome back to *${client.business_name}*. How can we help you today?`
        });
        return;
      } else {
        // New customer — ask for name
        setState(clientId, jid, { state: STATE.AWAITING_NAME });
        await humanDelay();
        await sock.sendMessage(jid, {
          text: `${timeGreeting()}! 👋 Welcome to *${client.business_name}*.\n\nMay I know your name please? 😊`
        });
        return;
      }
    }

    // ── STATE: AWAITING_NAME ─────────────────────────────────
    if (conv.state === STATE.AWAITING_NAME) {
      const name = text.trim().split(' ')[0]; // take first word as name
      const capitalName = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
      setState(clientId, jid, { state: STATE.BROWSING, customerName: capitalName });
      await getOrCreateCustomer(clientId, jid, capitalName);
      await humanDelay();
      await sock.sendMessage(jid, {
        text: `Nice to meet you, *${capitalName}*! 😊\n\nHow can we help you at *${client.business_name}* today?\n\n` +
          `You can:\n• Ask about our products/services\n• Place an order\n• Ask any question!`
      });
      return;
    }

    // ── From here, customer is known (state = BROWSING or ORDERING) ──
    const customerName = conv.customerName || 'there';
    const intent = detect(text);

    // ── CATALOG intent ───────────────────────────────────────
    if (intent === 'CATALOG') {
      const items = await getCatalog(clientId, bizType);
      await humanDelay();
      await sock.sendMessage(jid, { text: buildCatalogMsg(items, client.business_name) });
      return;
    }

    // ── HOURS intent ─────────────────────────────────────────
    if (intent === 'HOURS') {
      await humanDelay();
      const hours = client.business_hours || (setup?.availability_days) || 'Please contact us to confirm our operating hours.';
      await sock.sendMessage(jid, { text: `🕐 *Our Business Hours*\n\n${hours}\n\nFeel free to message us anytime — we respond during business hours! 😊` });
      return;
    }

    // ── DELIVERY intent ──────────────────────────────────────
    if (intent === 'DELIVERY') {
      await humanDelay();
      if (setup?.delivers_to) {
        let msg = `🚚 *Delivery Information*\n\n`;
        msg += `📍 We deliver to: *${setup.delivers_to}*\n`;
        if (setup.delivery_fee_local)    msg += `💰 Local delivery: *${setup.delivery_fee_local}*\n`;
        if (setup.delivery_fee_outside)  msg += `💰 Outside delivery: *${setup.delivery_fee_outside}*\n`;
        if (setup.delivery_time_local)   msg += `⏱️ Local timing: *${setup.delivery_time_local}*\n`;
        if (setup.delivery_time_outside) msg += `⏱️ Outside timing: *${setup.delivery_time_outside}*\n`;
        if (setup.minimum_order)         msg += `📦 Minimum order: *${setup.minimum_order}*\n`;
        await sock.sendMessage(jid, { text: msg });
      } else {
        await sock.sendMessage(jid, { text: `🚚 We offer delivery! Please contact us directly for delivery details and rates. 😊` });
      }
      return;
    }

    // ── SOCIAL intent ─────────────────────────────────────────
    if (intent === 'SOCIAL') {
      await humanDelay();
      if (setup) {
        let msg = `📱 *Find Us Online*\n\n`;
        if (setup.instagram)        msg += `📸 Instagram: ${setup.instagram}\n`;
        if (setup.facebook)         msg += `👍 Facebook: ${setup.facebook}\n`;
        if (setup.tiktok)           msg += `🎵 TikTok: ${setup.tiktok}\n`;
        if (setup.whatsapp_channel) msg += `📢 WhatsApp Channel: ${setup.whatsapp_channel}\n`;
        if (msg === `📱 *Find Us Online*\n\n`) msg += `We are building our social presence. Stay tuned! 😊`;
        await sock.sendMessage(jid, { text: msg });
      } else {
        await sock.sendMessage(jid, { text: `We will share our social links soon! 😊` });
      }
      return;
    }

    // ── PAYMENT_Q intent ─────────────────────────────────────
    if (intent === 'PAYMENT_Q') {
      await humanDelay();
      const accountMsg = buildAccountMsg(client);
      if (accountMsg) {
        await sock.sendMessage(jid, { text: accountMsg });
      } else {
        const methods = setup?.payment_methods || 'Bank transfer and other options available. Please ask us directly!';
        await sock.sendMessage(jid, { text: `💳 *Payment Methods*\n\n${methods}` });
      }
      return;
    }

    // ── PROMO intent ──────────────────────────────────────────
    if (intent === 'PROMO') {
      await humanDelay();
      const promo = setup?.current_promo;
      if (promo) {
        await sock.sendMessage(jid, { text: `🎉 *Current Promo*\n\n${promo}\n\nDon't miss out! 😍` });
      } else {
        await sock.sendMessage(jid, { text: `We currently have no active promo, but follow our page for updates! 😊` });
      }
      return;
    }

    // ── RETURN / COMPLAINT intent ─────────────────────────────
    if (intent === 'RETURN' || intent === 'COMPLAINT') {
      await humanDelay();
      const policy = intent === 'RETURN'
        ? (setup?.return_policy || 'Please contact us directly to arrange a return or exchange.')
        : (setup?.complaint_handling || 'We are sorry to hear that! Please share the details and we will resolve it right away.');
      await sock.sendMessage(jid, { text: `${intent === 'COMPLAINT' ? '😔' : '🔄'} *${intent === 'COMPLAINT' ? 'We are sorry to hear that!' : 'Return & Exchange Policy'}*\n\n${policy}` });
      return;
    }

    // ── REFERRAL intent ──────────────────────────────────────
    if (intent === 'REFERRAL') {
      await humanDelay();
      const reward = setup?.referral_reward;
      if (reward) {
        await sock.sendMessage(jid, { text: `🤝 *Referral Program*\n\n${reward}\n\nThank you for spreading the word! 🙏` });
      } else {
        await sock.sendMessage(jid, { text: `We love referrals! Contact us to learn about our referral program. 😊` });
      }
      return;
    }

    // ── BULK intent ───────────────────────────────────────────
    if (intent === 'BULK') {
      await humanDelay();
      const bulk = setup?.bulk_orders;
      if (bulk) {
        await sock.sendMessage(jid, { text: `📦 *Bulk Orders*\n\n${bulk}` });
      } else {
        await sock.sendMessage(jid, { text: `Yes, we accept bulk orders! Please contact us for special pricing. 😊` });
      }
      return;
    }

    // ── THANKS intent ─────────────────────────────────────────
    if (intent === 'THANKS') {
      await humanDelay();
      await sock.sendMessage(jid, { text: `You're welcome, *${customerName}*! 😊 Is there anything else I can help you with?` });
      return;
    }

    // ── PAYMENT_CLAIM intent ─────────────────────────────────
    if (intent === 'PAYMENT_CLAIM') {
      await humanDelay();
      await sock.sendMessage(jid, { text: `Thank you, *${customerName}*! Your payment claim has been received. Please send your *receipt/screenshot* and the owner will be notified right away. 📸` });
      setState(clientId, jid, { state: STATE.AWAITING_RECEIPT });
      await notifyOwnerOfPaymentClaim(sock, clientId, jid, text);
      return;
    }

    // ── STATE: AWAITING_ADDRESS ──────────────────────────────
    if (conv.state === STATE.AWAITING_ADDRESS) {
      const address = text.trim();
      setState(clientId, jid, { deliveryAddress: address });
      conv = getState(clientId, jid);

      // Create order in DB
      const total = conv.cart.reduce((sum, i) => sum + i.price * i.qty, 0);
      const { data: order } = await supabase.from('orders').insert({
        client_id:        clientId,
        customer_jid:     jid,
        customer_name:    customerName,
        items:            conv.cart,
        total,
        order_type:       'delivery',
        delivery_address: address,
        status:           'pending',
        payment_status:   'unpaid'
      }).select().single();

      const orderId = order?.id;
      setState(clientId, jid, { state: STATE.AWAITING_RECEIPT, orderId, orderData: { items: conv.cart, total } });

      // Send account details
      await humanDelay();
      const accountMsg = buildAccountMsg(client);
      const total_fmt  = fmt(total);
      let payMsg = `✅ *Order Received!*\n\n📦 Your items:\n`;
      conv.cart.forEach(i => { payMsg += `• ${i.name} × ${i.qty} — ${fmt(i.price * i.qty)}\n`; });
      payMsg += `\n💰 *Total: ${total_fmt}*\n📍 Delivery to: ${address}\n\n`;

      if (accountMsg) {
        payMsg += accountMsg;
      } else {
        payMsg += `Please transfer ${total_fmt} and send your receipt here. 🙏`;
      }

      await sock.sendMessage(jid, { text: payMsg });

      // Update customer order count
      await supabase.from('customers').update({
        order_count:  supabase.rpc ? undefined : undefined, // handled separately
        last_contact: new Date().toISOString()
      }).eq('client_id', clientId).eq('jid', jid);

      return;
    }

    // ── STATE: AWAITING_APPT ─────────────────────────────────
    if (conv.state === STATE.AWAITING_APPT) {
      const apptTime = text.trim();

      // Create booking in DB
      const total = conv.cart.reduce((sum, i) => sum + i.price * i.qty, 0);
      const { data: order } = await supabase.from('orders').insert({
        client_id:       clientId,
        customer_jid:    jid,
        customer_name:   customerName,
        items:           conv.cart,
        total,
        order_type:      'booking',
        appointment_time: apptTime,
        status:          'pending',
        payment_status:  'unpaid'
      }).select().single();

      const needsDeposit = setup?.deposit_required && setup.deposit_required.toLowerCase().includes('yes');
      setState(clientId, jid, { state: STATE.AWAITING_RECEIPT, orderId: order?.id, orderData: { items: conv.cart, total } });

      await humanDelay();
      let msg = `📅 *Booking Confirmed!*\n\n`;
      conv.cart.forEach(i => { msg += `• ${i.name}\n`; });
      msg += `\n🗓️ Date/Time: *${apptTime}*\n💰 Total: *${fmt(total)}*\n\n`;

      if (needsDeposit) {
        const depositInfo = setup.deposit_required;
        msg += `⚠️ *Deposit Required*: ${depositInfo}\n\n`;
        const accountMsg = buildAccountMsg(client);
        if (accountMsg) msg += accountMsg;
      } else {
        msg += `Your slot is confirmed! See you then. 😊`;
      }

      await sock.sendMessage(jid, { text: msg });
      await alertOwnerNewOrder(sock, client, { items: conv.cart, total, id: order?.id }, customerName);
      return;
    }

    // ── STATE: ORDERING — add to cart / checkout ─────────────
    if (conv.state === STATE.ORDERING) {
      // More items
      if (intent === 'MORE_ITEMS' || intent === 'ORDER') {
        // fall through to item matching below
      }
      // Done ordering — proceed to checkout
      if (intent === 'DONE_ORDER') {
        const isService = conv.cart.some(i => i._type === 'service');
        await humanDelay();
        if (isService) {
          setState(clientId, jid, { state: STATE.AWAITING_APPT });
          await sock.sendMessage(jid, { text: `Great! 😊 Please tell me your preferred *date and time* for your booking.` });
        } else {
          setState(clientId, jid, { state: STATE.AWAITING_ADDRESS });
          await sock.sendMessage(jid, { text: `Great choice, *${customerName}*! 😊\n\nPlease send your full *delivery address* so we can get this to you.` });
        }
        return;
      }
    }

    // ── PRICE / ORDER intent + product matching ───────────────
    if (intent === 'PRICE' || intent === 'ORDER' || conv.state === STATE.ORDERING) {
      const items = await getCatalog(clientId, bizType);
      if (!items.length) {
        await humanDelay();
        await sock.sendMessage(jid, { text: `We are currently updating our catalog. Please check back soon! 😊` });
        return;
      }

      const found = findItem(text, items);

      if (found) {
        if (intent === 'PRICE') {
          // Price inquiry — log it
          await supabase.from('price_inquiries').insert({
            client_id:    clientId,
            customer_jid: jid,
            customer_name: customerName,
            product_name: found.name,
            product_price: found.price,
            item_type:    found._type
          });

          await alertOwnerPriceInquiry(sock, client, customerName, found.name, found.price);
          await humanDelay();
          let msg = `${found._type === 'service' ? '✨' : '🛍️'} *${found.name}*\n💰 ${fmt(found.price)}`;
          if (found.description) msg += `\n📝 ${found.description}`;
          if (found._type === 'service' && found.duration) msg += `\n⏱️ Duration: ${found.duration}`;
          if (found._type === 'product' && setup?.delivery_fee_local) msg += `\n🚚 Local delivery: ${setup.delivery_fee_local}`;
          msg += `\n\nWould you like to *order* this? Just say "order" or "I want it"! 😊`;
          await sock.sendMessage(jid, { text: msg });
          return;
        }

        if (intent === 'ORDER' || conv.state === STATE.ORDERING) {
          // Add to cart
          const existingItem = (conv.cart || []).find(c => c.id === found.id);
          let newCart;
          if (existingItem) {
            newCart = conv.cart.map(c => c.id === found.id ? { ...c, qty: c.qty + 1 } : c);
          } else {
            newCart = [...(conv.cart || []), { id: found.id, name: found.name, price: found.price, qty: 1, _type: found._type }];
          }
          setState(clientId, jid, { state: STATE.ORDERING, cart: newCart });

          await humanDelay();
          const cartSummary = newCart.map(i => `• ${i.name} × ${i.qty} — ${fmt(i.price * i.qty)}`).join('\n');
          await sock.sendMessage(jid, {
            text: `✅ *${found.name}* added!\n\n🛒 *Your cart:*\n${cartSummary}\n\n💰 Total: *${fmt(newCart.reduce((s,i)=>s+i.price*i.qty,0))}*\n\nWant to add more? Or say *"done"* to checkout! 😊`
          });
          return;
        }
      } else if (intent === 'PRICE' || intent === 'ORDER') {
        // No specific item found — show catalog
        await humanDelay();
        await sock.sendMessage(jid, { text: buildCatalogMsg(items, client.business_name) });
        return;
      }
    }

    // ── Check custom Q&A ──────────────────────────────────────
    const customAnswer = await matchCustomQA(text, clientId);
    if (customAnswer) {
      await humanDelay();
      await sock.sendMessage(jid, { text: customAnswer });
      return;
    }

    // ── Greeting response ──────────────────────────────────────
    if (intent === 'GREETING_W') {
      await humanDelay();
      await sock.sendMessage(jid, {
        text: `${timeGreeting()} *${customerName}*! 👋 Welcome to *${client.business_name}*. How can we help you today?`
      });
      return;
    }

    // ── Check existing flows (your original keyword system) ───
    const flows = await db.getFlows(clientId, true);
    let matched = null;
    for (const flow of flows) {
      const kws = flow.keywords.split(',').map(k => k.trim().toLowerCase());
      if (kws.some(kw => text.toLowerCase().includes(kw))) { matched = flow; break; }
    }

    await humanDelay();
    await sock.sendPresenceUpdate('paused', jid);

    if (matched) {
      if (matched.response_type === 'image' && matched.media_url) {
        await sock.sendMessage(jid, { image: { url: matched.media_url }, caption: matched.response });
      } else {
        await sock.sendMessage(jid, { text: matched.response });
      }
      return;
    }

    // ── Fallback ───────────────────────────────────────────────
    const fallback = client.fallback_message ||
      `Thank you for reaching out to *${client.business_name}*! 😊 Someone will get back to you shortly. You can also:\n• Ask about our products/services\n• Place an order\n• Ask about delivery`;
    await sock.sendMessage(jid, { text: fallback });

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
