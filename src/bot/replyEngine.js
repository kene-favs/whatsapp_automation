// ============================================================
//  ForgeBot — Smart Reply Engine
//  File: src/bot/replyEngine.js
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const db = require('../db/supabase');
const { transcribeVoiceNote } = require('./voiceHandler');
const {
  isPaymentClaim,
  notifyOwnerOfPaymentClaim,
  handleOwnerReply,
  notifyOwnerHumanRequest
} = require('./paymentNotifier');

// ── Lazy Supabase client (avoids crash if env vars load after require) ────────
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('[ReplyEngine] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — add them to Railway Variables.');
    }
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

// ── Conversation state ────────────────────────────────────────
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

const convStates = new Map();

function getState(clientId, jid) {
  return convStates.get(clientId + ':' + jid) || { state: STATE.GREETING, cart: [] };
}
function setState(clientId, jid, data) {
  convStates.set(clientId + ':' + jid, { ...getState(clientId, jid), ...data });
}

// ── Intent detection ──────────────────────────────────────────
const INTENTS = {
  CATALOG:    ['catalog','catalogue','products','what do you have','what you have','show me','menu','list','what do you sell','your items','your products','your services','price list'],
  PRICE:      ['how much','price','cost','fee','rate','amount','naira','how much is','what is the price','cost of'],
  ORDER:      ['i want','order','buy','purchase','get','i need',"i'll take",'i will take','send me','place order','i go buy'],
  MORE_ITEMS: ['add','also','and','more','another','plus','i also want','i need more'],
  DONE_ORDER: ['that is all',"that's all",'done','finish','checkout','i am done','nothing else','no more',"that's it",'thats it','complete order'],
  DELIVERY:   ['deliver','delivery','shipping','ship','how long','when will','location','where are you','your address','office','pickup'],
  HOURS:      ['open','close','hours','time','when','available','working hours','office hours','what time'],
  SOCIAL:     ['instagram','facebook','tiktok','twitter','youtube','social','follow','page','channel','whatsapp channel'],
  PAYMENT_Q:  ['account','bank','how do i pay','payment','transfer','how to pay','account number','account name','your bank'],
  COMPLAINT:  ['complain','complaint','bad','wrong','issue','problem','not happy','disappointed','rubbish','terrible'],
  RETURN:     ['return','refund','exchange','send back','wrong item','not what i','damaged'],
  BULK:       ['bulk','wholesale','many','large order','large quantity','discount for'],
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

// ── Fuzzy match (40% word overlap) ───────────────────────────
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
}
function findItem(text, items) {
  const q = normalize(text);
  let best = null, bestScore = 0;
  for (const item of items) {
    const n = normalize(item.name);
    const matches = q.filter(w => n.some(x => x.includes(w) || w.includes(x)));
    const score = matches.length / Math.max(q.length, n.length);
    if (score > bestScore && score >= 0.4) { bestScore = score; best = item; }
  }
  return best;
}

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmt(num) { return '₦' + Number(num).toLocaleString('en-NG'); }
function humanDelay() { return new Promise(r => setTimeout(r, 1000 + Math.random() * 1500)); }

function buildAccountMsg(client) {
  if (!client.bank_name && !client.account_number) return null;
  return '*Payment Details*\n' +
    'Bank: *' + (client.bank_name || 'N/A') + '*\n' +
    'Account Number: *' + (client.account_number || 'N/A') + '*\n' +
    'Account Name: *' + (client.account_name || 'N/A') + '*\n\n' +
    'After payment, please send your *receipt/screenshot* here so we can confirm.';
}

async function getCatalog(clientId, bizType) {
  const supabase = getSupabase();
  const items = [];
  if (bizType === 'products' || bizType === 'both') {
    const { data } = await supabase.from('products').select('*').eq('client_id', clientId).eq('in_stock', true);
    (data || []).forEach(p => items.push({ ...p, _type: 'product' }));
  }
  if (bizType === 'services' || bizType === 'both') {
    const { data } = await supabase.from('services').select('*').eq('client_id', clientId).eq('available', true);
    (data || []).forEach(s => items.push({ ...s, _type: 'service' }));
  }
  return items;
}

function buildCatalogMsg(items, bizName) {
  if (!items.length) return 'We are currently updating our catalog. Please check back soon!';
  let msg = 'Welcome to *' + bizName + '* — Here is what we offer:\n\n';
  const products = items.filter(i => i._type === 'product');
  const services = items.filter(i => i._type === 'service');
  if (products.length) {
    msg += '*Our Products*\n';
    products.forEach((p, i) => {
      msg += (i + 1) + '. *' + p.name + '* — ' + fmt(p.price) + '\n';
      if (p.description) msg += '   _' + p.description + '_\n';
    });
    msg += '\n';
  }
  if (services.length) {
    msg += '*Our Services*\n';
    services.forEach((s, i) => {
      msg += (i + 1) + '. *' + s.name + '* — ' + fmt(s.price) + '\n';
      if (s.duration) msg += '   Time: ' + s.duration + '\n';
    });
    msg += '\n';
  }
  msg += 'To order, just tell me what you want!';
  return msg;
}

async function matchCustomQA(text, clientId) {
  const supabase = getSupabase();
  const { data: setup } = await supabase.from('bot_setup')
    .select('custom_service_1_q,custom_service_1_a,custom_service_2_q,custom_service_2_a,custom_service_3_q,custom_service_3_a')
    .eq('client_id', clientId).single();
  if (!setup) return null;
  const pairs = [
    [setup.custom_service_1_q, setup.custom_service_1_a],
    [setup.custom_service_2_q, setup.custom_service_2_a],
    [setup.custom_service_3_q, setup.custom_service_3_a]
  ].filter(([q, a]) => q && a);
  const qw = normalize(text);
  for (const [question, answer] of pairs) {
    const kw = normalize(question);
    const matches = qw.filter(w => kw.some(k => k.includes(w) || w.includes(k)));
    if (matches.length / Math.max(qw.length, kw.length) >= 0.5) return answer;
  }
  return null;
}

async function getOrCreateCustomer(clientId, jid, name) {
  const supabase = getSupabase();
  const { data } = await supabase.from('customers').select('*').eq('client_id', clientId).eq('jid', jid).single();
  if (data) {
    await supabase.from('customers').update({ last_contact: new Date().toISOString(), name: name || data.name }).eq('id', data.id);
    return data;
  }
  const { data: newCust } = await supabase.from('customers')
    .insert({ client_id: clientId, jid, name: name || null, phone: jid.replace('@s.whatsapp.net', '') })
    .select().single();
  return newCust;
}

async function saveReceiptImage(sock, msg, clientId) {
  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: { error: () => {}, warn: () => {}, info: () => {} } });
    const filename = 'receipts/' + clientId + '/' + Date.now() + '.jpg';
    const supabase = getSupabase();
    const { error } = await supabase.storage.from('forgebot-receipts').upload(filename, buffer, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    const { data } = supabase.storage.from('forgebot-receipts').getPublicUrl(filename);
    return data.publicUrl;
  } catch (e) {
    console.error('[ReplyEngine] Receipt upload failed:', e.message);
    return null;
  }
}

async function alertOwner(sock, client, order, customerName) {
  try {
    const appUrl = process.env.APP_URL || 'https://yourapp.railway.app';
    const dashUrl = appUrl + '/dashboard?token=' + (client.token || '');
    const itemList = order.items.map(i => '• ' + i.name + ' x' + i.qty + ' — ' + fmt(i.price * i.qty)).join('\n');
    const msg = 'New Order — *' + client.business_name + '*\n\n' +
      'Customer: *' + customerName + '*\n' +
      'Items:\n' + itemList + '\n' +
      'Total: *' + fmt(order.total) + '*\n\n' +
      'Reply *1* to confirm payment\nReply *2* to reject\n\n' +
      'View order: ' + dashUrl;
    const ownerJid = client.notification_number ? client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net' : null;
    if (ownerJid && sock) await sock.sendMessage(ownerJid, { text: msg });
  } catch (e) { console.error('[ReplyEngine] Owner alert failed:', e.message); }
}

async function alertOwnerInquiry(sock, client, customerName, itemName, price) {
  try {
    const appUrl = process.env.APP_URL || 'https://yourapp.railway.app';
    const dashUrl = appUrl + '/dashboard?token=' + (client.token || '');
    const msg = 'Price Inquiry — ' + client.business_name + '\n*' + customerName + '* asked about *' + itemName + '* (' + fmt(price) + ')\n\n' + dashUrl;
    const ownerJid = client.notification_number ? client.notification_number.replace(/\D/g, '') + '@s.whatsapp.net' : null;
    if (ownerJid && sock) await sock.sendMessage(ownerJid, { text: msg });
  } catch (_) {}
}

async function handleOwnerPaymentReply(sock, text, clientId) {
  const t = text.trim();
  if (t !== '1' && t !== '2') return false;
  const supabase = getSupabase();
  const { data: orders } = await supabase.from('orders').select('*').eq('client_id', clientId).eq('payment_status', 'unpaid').not('receipt_url', 'is', null).order('created_at', { ascending: false }).limit(1);
  if (!orders || !orders.length) return false;
  const order = orders[0];
  const confirmed = t === '1';
  await supabase.from('orders').update({ payment_status: confirmed ? 'confirmed' : 'rejected', status: confirmed ? 'accepted' : 'pending', updated_at: new Date().toISOString() }).eq('id', order.id);
  const msg = confirmed
    ? 'Your payment has been *confirmed*! Your order is now being processed. Thank you!'
    : 'We could not verify your payment. Please resend a *clear screenshot* of your bank transfer or contact us directly.';
  if (sock) await sock.sendMessage(order.customer_jid, { text: msg });
  return true;
}

// ============================================================
//  MAIN HANDLER
// ============================================================
async function handleMessage(sock, msg, clientId) {
  try {
    const jid = msg.key.remoteJid;
    if (jid === 'status@broadcast') return;

    const supabase = getSupabase();
    const msgContent = msg.message;
    const isVoice = !!(msgContent && msgContent.audioMessage && msgContent.audioMessage.ptt);
    const isAudio = !!(msgContent && msgContent.audioMessage);
    const isImage = !!(msgContent && msgContent.imageMessage);

    let text = (msgContent && msgContent.conversation) ||
               (msgContent && msgContent.extendedTextMessage && msgContent.extendedTextMessage.text) ||
               (msgContent && msgContent.imageMessage && msgContent.imageMessage.caption) || '';

    const client = await db.getClientById(clientId);
    if (!client || client.status !== 'active') return;

    // Owner payment reply (1 or 2)
    const ownerPayment = await handleOwnerPaymentReply(sock, text, clientId);
    if (ownerPayment) return;

    // Existing owner handler
    const ownerHandled = await handleOwnerReply(sock, jid, text, clientId);
    if (ownerHandled) return;

    const { data: setup } = await supabase.from('bot_setup').select('*').eq('client_id', clientId).single();
    const bizType = client.business_type || 'products';
    let conv = getState(clientId, jid);

    // Voice note
    if (isVoice || isAudio) {
      await sock.sendPresenceUpdate('composing', jid);
      const transcribed = await transcribeVoiceNote(sock, msg);
      if (!transcribed) {
        await humanDelay();
        await sock.sendMessage(jid, { text: 'I received your voice note! Could you please *type your message* so I can help you faster?' });
        return;
      }
      text = transcribed;
      await sock.sendMessage(jid, { text: 'I heard: _"' + transcribed + '"_\n\nLet me help you...' });
    }

    // Image (receipt)
    if (isImage && conv.state === STATE.AWAITING_RECEIPT && conv.orderId) {
      await sock.sendPresenceUpdate('composing', jid);
      await humanDelay();
      const receiptUrl = await saveReceiptImage(sock, msg, clientId);
      if (receiptUrl) {
        await supabase.from('orders').update({ receipt_url: receiptUrl }).eq('id', conv.orderId);
        await sock.sendMessage(jid, { text: 'Thank you! Your receipt has been received. The owner will confirm your payment shortly. We will notify you right away!' });
        await alertOwner(sock, client, { ...conv.orderData, id: conv.orderId }, conv.customerName || 'Customer');
        setState(clientId, jid, { state: STATE.BROWSING });
      } else {
        await sock.sendMessage(jid, { text: 'Sorry, I could not receive that image clearly. Please try again with a clearer screenshot.' });
      }
      return;
    }

    if (!text.trim()) return;

    await sock.sendPresenceUpdate('composing', jid);
    const intent = detect(text);

    // Human handoff
    if (conv.state !== STATE.HUMAN_PAUSED && intent === 'HUMAN') {
      await humanDelay();
      await sock.sendMessage(jid, { text: 'Got it! Connecting you with the owner right now. Please hold on.' });
      setState(clientId, jid, { state: STATE.HUMAN_PAUSED, pausedUntil: Date.now() + 30 * 60 * 1000 });
      await notifyOwnerHumanRequest(sock, clientId, jid);
      return;
    }

    // Human paused
    if (conv.state === STATE.HUMAN_PAUSED) {
      if (conv.pausedUntil && Date.now() < conv.pausedUntil) return;
      setState(clientId, jid, { state: STATE.BROWSING });
      conv = getState(clientId, jid);
    }

    // GREETING — check existing customer
    if (conv.state === STATE.GREETING) {
      const existing = await getOrCreateCustomer(clientId, jid, null);
      if (existing && existing.name) {
        setState(clientId, jid, { state: STATE.BROWSING, customerName: existing.name });
        await humanDelay();
        await sock.sendMessage(jid, { text: timeGreeting() + ' *' + existing.name + '*! Welcome back to *' + client.business_name + '*. How can we help you today?' });
      } else {
        setState(clientId, jid, { state: STATE.AWAITING_NAME });
        await humanDelay();
        await sock.sendMessage(jid, { text: timeGreeting() + '! Welcome to *' + client.business_name + '*.\n\nMay I know your name please?' });
      }
      return;
    }

    // AWAITING_NAME
    if (conv.state === STATE.AWAITING_NAME) {
      const rawName = text.trim().split(' ')[0];
      const name = rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
      setState(clientId, jid, { state: STATE.BROWSING, customerName: name });
      await getOrCreateCustomer(clientId, jid, name);
      await humanDelay();
      await sock.sendMessage(jid, { text: 'Nice to meet you, *' + name + '*!\n\nHow can we help you at *' + client.business_name + '*?\n\nYou can ask about our products, prices, place an order, or ask any question!' });
      return;
    }

    const customerName = conv.customerName || 'there';

    // AWAITING_ADDRESS
    if (conv.state === STATE.AWAITING_ADDRESS) {
      const address = text.trim();
      const total = conv.cart.reduce((s, i) => s + i.price * i.qty, 0);
      const { data: order } = await supabase.from('orders').insert({
        client_id: clientId, customer_jid: jid, customer_name: customerName,
        items: conv.cart, total, order_type: 'delivery', delivery_address: address,
        status: 'pending', payment_status: 'unpaid'
      }).select().single();

      setState(clientId, jid, { state: STATE.AWAITING_RECEIPT, orderId: order && order.id, orderData: { items: conv.cart, total } });

      await humanDelay();
      let payMsg = 'Order received!\n\nYour items:\n';
      conv.cart.forEach(i => { payMsg += '• ' + i.name + ' x' + i.qty + ' — ' + fmt(i.price * i.qty) + '\n'; });
      payMsg += '\nTotal: *' + fmt(total) + '*\nDelivery to: ' + address + '\n\n';
      const accMsg = buildAccountMsg(client);
      payMsg += accMsg || ('Please transfer ' + fmt(total) + ' and send your receipt here.');
      await sock.sendMessage(jid, { text: payMsg });
      return;
    }

    // AWAITING_APPT
    if (conv.state === STATE.AWAITING_APPT) {
      const apptTime = text.trim();
      const total = conv.cart.reduce((s, i) => s + i.price * i.qty, 0);
      const { data: order } = await supabase.from('orders').insert({
        client_id: clientId, customer_jid: jid, customer_name: customerName,
        items: conv.cart, total, order_type: 'booking', appointment_time: apptTime,
        status: 'pending', payment_status: 'unpaid'
      }).select().single();

      const needsDeposit = setup && setup.deposit_required && setup.deposit_required.toLowerCase().includes('yes');
      setState(clientId, jid, { state: STATE.AWAITING_RECEIPT, orderId: order && order.id, orderData: { items: conv.cart, total } });

      await humanDelay();
      let msg = 'Booking confirmed!\n\n';
      conv.cart.forEach(i => { msg += '• ' + i.name + '\n'; });
      msg += '\nDate/Time: *' + apptTime + '*\nTotal: *' + fmt(total) + '*\n\n';
      if (needsDeposit) {
        msg += 'Deposit required: ' + setup.deposit_required + '\n\n';
        const accMsg = buildAccountMsg(client);
        if (accMsg) msg += accMsg;
      } else {
        msg += 'Your slot is confirmed! See you then.';
      }
      await sock.sendMessage(jid, { text: msg });
      await alertOwner(sock, client, { items: conv.cart, total }, customerName);
      return;
    }

    // ORDERING — done?
    if (conv.state === STATE.ORDERING && intent === 'DONE_ORDER') {
      const isService = conv.cart.some(i => i._type === 'service');
      await humanDelay();
      if (isService) {
        setState(clientId, jid, { state: STATE.AWAITING_APPT });
        await sock.sendMessage(jid, { text: 'Please tell me your preferred *date and time* for your booking.' });
      } else {
        setState(clientId, jid, { state: STATE.AWAITING_ADDRESS });
        await sock.sendMessage(jid, { text: 'Please send your full *delivery address*.' });
      }
      return;
    }

    // CATALOG
    if (intent === 'CATALOG') {
      const items = await getCatalog(clientId, bizType);
      await humanDelay();
      await sock.sendMessage(jid, { text: buildCatalogMsg(items, client.business_name) });
      return;
    }

    // HOURS
    if (intent === 'HOURS') {
      const hours = (client.business_hours) || (setup && setup.availability_days) || 'Please contact us to confirm our hours.';
      await humanDelay();
      await sock.sendMessage(jid, { text: 'Our business hours:\n\n' + hours });
      return;
    }

    // DELIVERY
    if (intent === 'DELIVERY') {
      await humanDelay();
      if (setup && setup.delivers_to) {
        let msg = 'Delivery Information\n\n';
        msg += 'We deliver to: *' + setup.delivers_to + '*\n';
        if (setup.delivery_fee_local) msg += 'Local fee: *' + setup.delivery_fee_local + '*\n';
        if (setup.delivery_fee_outside) msg += 'Outside fee: *' + setup.delivery_fee_outside + '*\n';
        if (setup.delivery_time_local) msg += 'Local timing: *' + setup.delivery_time_local + '*\n';
        if (setup.delivery_time_outside) msg += 'Outside timing: *' + setup.delivery_time_outside + '*\n';
        if (setup.minimum_order) msg += 'Minimum order: *' + setup.minimum_order + '*\n';
        await sock.sendMessage(jid, { text: msg });
      } else {
        await sock.sendMessage(jid, { text: 'We offer delivery! Please contact us for details and rates.' });
      }
      return;
    }

    // SOCIAL
    if (intent === 'SOCIAL') {
      await humanDelay();
      if (setup) {
        let msg = 'Find Us Online\n\n';
        if (setup.instagram) msg += 'Instagram: ' + setup.instagram + '\n';
        if (setup.facebook) msg += 'Facebook: ' + setup.facebook + '\n';
        if (setup.tiktok) msg += 'TikTok: ' + setup.tiktok + '\n';
        if (setup.whatsapp_channel) msg += 'WhatsApp Channel: ' + setup.whatsapp_channel + '\n';
        if (msg === 'Find Us Online\n\n') msg += 'We are building our social presence. Stay tuned!';
        await sock.sendMessage(jid, { text: msg });
      } else {
        await sock.sendMessage(jid, { text: 'We will share our social links soon!' });
      }
      return;
    }

    // PAYMENT_Q
    if (intent === 'PAYMENT_Q') {
      await humanDelay();
      const accMsg = buildAccountMsg(client);
      if (accMsg) {
        await sock.sendMessage(jid, { text: accMsg });
      } else {
        const methods = (setup && setup.payment_methods) || 'Bank transfer and other options. Please ask us directly!';
        await sock.sendMessage(jid, { text: 'Payment Methods\n\n' + methods });
      }
      return;
    }

    // PROMO
    if (intent === 'PROMO') {
      await humanDelay();
      const promo = setup && setup.current_promo;
      if (promo) {
        await sock.sendMessage(jid, { text: 'Current Promo\n\n' + promo + "\n\nDon't miss out!" });
      } else {
        await sock.sendMessage(jid, { text: 'No active promo right now, but follow our page for updates!' });
      }
      return;
    }

    // COMPLAINT / RETURN
    if (intent === 'COMPLAINT' || intent === 'RETURN') {
      await humanDelay();
      const policy = intent === 'RETURN'
        ? ((setup && setup.return_policy) || 'Please contact us to arrange a return or exchange.')
        : ((setup && setup.complaint_handling) || 'We are sorry to hear that! Please share the details and we will resolve it right away.');
      await sock.sendMessage(jid, { text: policy });
      return;
    }

    // BULK
    if (intent === 'BULK') {
      await humanDelay();
      const bulk = setup && setup.bulk_orders;
      if (bulk) {
        await sock.sendMessage(jid, { text: 'Bulk Orders\n\n' + bulk });
      } else {
        await sock.sendMessage(jid, { text: 'Yes, we accept bulk orders! Contact us for special pricing.' });
      }
      return;
    }

    // REFERRAL
    if (intent === 'REFERRAL') {
      await humanDelay();
      const reward = setup && setup.referral_reward;
      if (reward) {
        await sock.sendMessage(jid, { text: 'Referral Program\n\n' + reward });
      } else {
        await sock.sendMessage(jid, { text: 'We love referrals! Contact us to learn about our referral program.' });
      }
      return;
    }

    // PAYMENT_CLAIM
    if (intent === 'PAYMENT_CLAIM') {
      await humanDelay();
      await sock.sendMessage(jid, { text: 'Thank you! Please send your *receipt/screenshot* and the owner will confirm your payment right away.' });
      setState(clientId, jid, { state: STATE.AWAITING_RECEIPT });
      await notifyOwnerOfPaymentClaim(sock, clientId, jid, text);
      return;
    }

    // THANKS
    if (intent === 'THANKS') {
      await humanDelay();
      await sock.sendMessage(jid, { text: "You're welcome, *" + customerName + "*! Is there anything else I can help you with?" });
      return;
    }

    // GREETING
    if (intent === 'GREETING_W') {
      await humanDelay();
      await sock.sendMessage(jid, { text: timeGreeting() + ' *' + customerName + '*! Welcome to *' + client.business_name + '*. How can we help you today?' });
      return;
    }

    // PRICE / ORDER — find product
    if (intent === 'PRICE' || intent === 'ORDER' || conv.state === STATE.ORDERING) {
      const items = await getCatalog(clientId, bizType);
      if (!items.length) {
        await humanDelay();
        await sock.sendMessage(jid, { text: 'We are currently updating our catalog. Please check back soon!' });
        return;
      }
      const found = findItem(text, items);
      if (found) {
        if (intent === 'PRICE') {
          await supabase.from('price_inquiries').insert({ client_id: clientId, customer_jid: jid, customer_name: customerName, product_name: found.name, product_price: found.price, item_type: found._type });
          await alertOwnerInquiry(sock, client, customerName, found.name, found.price);
          await humanDelay();
          let msg = '*' + found.name + '*\n' + fmt(found.price);
          if (found.description) msg += '\n' + found.description;
          if (found._type === 'service' && found.duration) msg += '\nDuration: ' + found.duration;
          msg += '\n\nWould you like to order this? Just say "order"!';
          await sock.sendMessage(jid, { text: msg });
        } else {
          const existingItem = (conv.cart || []).find(c => c.id === found.id);
          const newCart = existingItem
            ? conv.cart.map(c => c.id === found.id ? { ...c, qty: c.qty + 1 } : c)
            : [...(conv.cart || []), { id: found.id, name: found.name, price: found.price, qty: 1, _type: found._type }];
          setState(clientId, jid, { state: STATE.ORDERING, cart: newCart });
          await humanDelay();
          const cartSummary = newCart.map(i => '• ' + i.name + ' x' + i.qty + ' — ' + fmt(i.price * i.qty)).join('\n');
          const cartTotal = newCart.reduce((s, i) => s + i.price * i.qty, 0);
          await sock.sendMessage(jid, { text: '*' + found.name + '* added!\n\nYour cart:\n' + cartSummary + '\n\nTotal: *' + fmt(cartTotal) + '*\n\nWant to add more? Or say *done* to checkout!' });
        }
        return;
      } else if (intent === 'PRICE' || intent === 'ORDER') {
        await humanDelay();
        await sock.sendMessage(jid, { text: buildCatalogMsg(items, client.business_name) });
        return;
      }
    }

    // Custom Q&A
    const customAnswer = await matchCustomQA(text, clientId);
    if (customAnswer) {
      await humanDelay();
      await sock.sendMessage(jid, { text: customAnswer });
      return;
    }

    // Existing keyword flows
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

    const fallback = client.fallback_message || ('Thank you for reaching out to *' + client.business_name + '*! Someone will get back to you shortly.');
    await sock.sendMessage(jid, { text: fallback });

  } catch (err) {
    console.error('[ReplyEngine] Error for client ' + clientId + ':', err.message);
  }
}

module.exports = { handleMessage };
