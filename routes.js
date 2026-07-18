// ============================================================
//  ForgeBot — Client Dashboard API Routes
//  File: routes.js  (place in project ROOT, next to index.js)
//  Mounted in index.js as: app.use('/api', require('./routes'))
//
//  npm install multer web-push jsonwebtoken @supabase/supabase-js bcryptjs
// ============================================================

const express  = require('express');
const multer   = require('multer');
const webpush  = require('web-push');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const router  = express.Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Supabase ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── VAPID (Web Push) ──────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:' + (process.env.VAPID_MAILTO || 'admin@forgebot.app'),
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ── Auth middleware ───────────────────────────────────────────
function auth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.clientId = decoded.clientId;
    req.token    = token;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Helper: get client row ────────────────────────────────────
async function getClient(clientId) {
  const { data, error } = await supabase
    .from('clients').select('*').eq('id', clientId).single();
  if (error) throw error;
  return data;
}

// ── Helper: get Baileys sock via sessionManager ───────────────
// index.js sets global.getSock = (clientId) => sessionManager.getSession(clientId)
function getSock(clientId) {
  return typeof global.getSock === 'function' ? global.getSock(clientId) : null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }


// ============================================================
//  SIGNUP
//  POST /api/client/signup
// ============================================================
router.post('/client/signup', async (req, res) => {
  try {
    const {
      business_name, email, password, phone,
      business_category, plan,
      bank_name, account_number, account_name
    } = req.body;

    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(password, 10);

    const { data: client, error } = await supabase
      .from('clients')
      .insert({
        business_name, email, password_hash, phone,
        business_category, plan: plan || 'free',
        bank_name, account_number, account_name,
        setup_completed: false
      })
      .select().single();

    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Email already registered' });
      throw error;
    }

    const token = jwt.sign({ clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, clientId: client.id });
  } catch (e) {
    console.error('signup error', e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
//  LOGIN
//  POST /api/client/login
// ============================================================
router.post('/client/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const bcrypt = require('bcryptjs');

    const { data: client, error } = await supabase
      .from('clients').select('*').eq('email', email).single();

    if (error || !client) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign({ clientId: client.id }, process.env.JWT_SECRET, { expiresIn: '90d' });
    res.json({ token, clientId: client.id, setup_completed: client.setup_completed });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
//  QR STREAM  (SSE — streams Baileys QR to onboard.html)
//  GET /api/client/qr-stream?token=TOKEN
//
//  In your sessionManager, after Baileys fires a QR:
//    const listeners = global.qrListeners?.get(clientId) || [];
//    listeners.forEach(fn => fn({ type:'qr', qr }));
//
//  After Baileys connects (connection === 'open'):
//    const listeners = global.qrListeners?.get(clientId) || [];
//    listeners.forEach(fn => fn({ type:'connected' }));
// ============================================================
router.get('/client/qr-stream', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = req.clientId;
  if (!global.qrListeners) global.qrListeners = new Map();

  const send = (obj) => {
    try { res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
  };

  const list = global.qrListeners.get(clientId) || [];
  list.push(send);
  global.qrListeners.set(clientId, list);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    const arr = (global.qrListeners.get(clientId) || []).filter(f => f !== send);
    if (arr.length) global.qrListeners.set(clientId, arr);
    else global.qrListeners.delete(clientId);
  });
});


// ============================================================
//  BOT SETUP  (questionnaire submitted after QR scan)
//  POST /api/client/setup
// ============================================================
router.post('/client/setup', auth, async (req, res) => {
  try {
    const clientId = req.clientId;
    const body = req.body;

    const { error: setupErr } = await supabase
      .from('bot_setup')
      .upsert({
        client_id:             clientId,
        delivers_to:           body.delivers_to,
        delivery_fee_local:    body.delivery_fee_local,
        delivery_fee_outside:  body.delivery_fee_outside,
        delivery_time_local:   body.delivery_time_local,
        delivery_time_outside: body.delivery_time_outside,
        payment_on_delivery:   body.payment_on_delivery,
        minimum_order:         body.minimum_order,
        home_service:          body.home_service,
        studio_location:       body.studio_location,
        availability_days:     body.availability_days,
        session_duration:      body.session_duration,
        deposit_required:      body.deposit_required,
        advance_booking:       body.advance_booking,
        who_do_you_serve:      body.who_do_you_serve,
        return_policy:         body.return_policy,
        complaint_handling:    body.complaint_handling,
        bulk_orders:           body.bulk_orders,
        referral_reward:       body.referral_reward,
        payment_methods:       body.payment_methods,
        current_promo:         body.current_promo,
        custom_service_1_q:    body.custom_service_1_q,
        custom_service_1_a:    body.custom_service_1_a,
        custom_service_2_q:    body.custom_service_2_q,
        custom_service_2_a:    body.custom_service_2_a,
        custom_service_3_q:    body.custom_service_3_q,
        custom_service_3_a:    body.custom_service_3_a,
        instagram:             body.instagram,
        facebook:              body.facebook,
        tiktok:                body.tiktok,
        whatsapp_channel:      body.whatsapp_channel,
        updated_at:            new Date().toISOString()
      }, { onConflict: 'client_id' });

    if (setupErr) throw setupErr;

    const { error: clientErr } = await supabase
      .from('clients')
      .update({
        setup_completed: true,
        business_type:   body.business_type || 'products',
        business_hours:  body.business_hours || null
      })
      .eq('id', clientId);

    if (clientErr) throw clientErr;
    res.json({ ok: true });
  } catch (e) {
    console.error('setup error', e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
//  IMAGE UPLOAD  (products + receipts)
//  POST /api/upload  — multipart/form-data, field: "file"
//  Returns: { url }
// ============================================================
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const ext     = req.file.originalname.split('.').pop().toLowerCase();
    const allowed = ['jpg','jpeg','png','webp','gif'];
    if (!allowed.includes(ext)) return res.status(400).json({ error: 'Invalid file type' });

    const filename = `${req.clientId}/${Date.now()}.${ext}`;
    const bucket   = 'forgebot-products';

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(filename, req.file.buffer, { contentType: req.file.mimetype, upsert: false });

    if (upErr) throw upErr;

    const { data } = supabase.storage.from(bucket).getPublicUrl(filename);
    res.json({ url: data.publicUrl });
  } catch (e) {
    console.error('upload error', e);
    res.status(500).json({ error: e.message });
  }
});


// ============================================================
//  PRODUCTS CRUD
// ============================================================
router.get('/client/products', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/products', auth, async (req, res) => {
  try {
    const { name, price, description, image_url, in_stock } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price required' });

    const { data, error } = await supabase
      .from('products')
      .insert({ client_id: req.clientId, name, price, description, image_url, in_stock: in_stock !== false })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/products/:id', auth, async (req, res) => {
  try {
    const { name, price, description, image_url, in_stock } = req.body;
    const { data, error } = await supabase
      .from('products')
      .update({ name, price, description, image_url, in_stock })
      .eq('id', req.params.id).eq('client_id', req.clientId)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/products/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('products').delete()
      .eq('id', req.params.id).eq('client_id', req.clientId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  SERVICES CRUD
// ============================================================
router.get('/client/services', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('services').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/services', auth, async (req, res) => {
  try {
    const { name, price, description, duration, available } = req.body;
    if (!name || price == null) return res.status(400).json({ error: 'name and price required' });

    const { data, error } = await supabase
      .from('services')
      .insert({ client_id: req.clientId, name, price, description, duration, available: available !== false })
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/services/:id', auth, async (req, res) => {
  try {
    const { name, price, description, duration, available } = req.body;
    const { data, error } = await supabase
      .from('services')
      .update({ name, price, description, duration, available })
      .eq('id', req.params.id).eq('client_id', req.clientId)
      .select().single();
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/client/services/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('services').delete()
      .eq('id', req.params.id).eq('client_id', req.clientId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  ORDERS
// ============================================================
router.get('/client/orders', auth, async (req, res) => {
  try {
    let query = supabase.from('orders').select('*')
      .eq('client_id', req.clientId)
      .order('created_at', { ascending: false });

    if (req.query.status)         query = query.eq('status', req.query.status);
    if (req.query.payment_status) query = query.eq('payment_status', req.query.payment_status);
    if (req.query.since)          query = query.gte('created_at', req.query.since);

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/client/orders/:id', auth, async (req, res) => {
  try {
    const allowed = ['pending','accepted','in_delivery','delivered','completed','cancelled'];
    const { status } = req.body;
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const { data, error } = await supabase
      .from('orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('client_id', req.clientId)
      .select().single();

    if (error) throw error;
    await notifyCustomerOrderStatus(data);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/client/orders/:id/payment', auth, async (req, res) => {
  try {
    const { action } = req.body; // 'confirm' | 'reject'
    if (!['confirm','reject'].includes(action)) return res.status(400).json({ error: 'action must be confirm or reject' });

    const payment_status = action === 'confirm' ? 'confirmed' : 'rejected';
    const newStatus      = action === 'confirm' ? 'accepted'  : 'pending';

    const { data, error } = await supabase
      .from('orders')
      .update({ payment_status, status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('client_id', req.clientId)
      .select().single();

    if (error) throw error;
    await notifyCustomerPayment(data, action);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  PRICE INQUIRIES (LEADS)
// ============================================================
router.get('/client/inquiries', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('price_inquiries').select('*').eq('client_id', req.clientId)
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Broadcast a message to all leads (people who inquired about prices)
router.post('/client/inquiries/broadcast', auth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const { data: inquiries } = await supabase
      .from('price_inquiries').select('customer_jid').eq('client_id', req.clientId);

    const jids = [...new Set((inquiries || []).map(i => i.customer_jid))];
    const sock = getSock(req.clientId);
    if (!sock) return res.status(503).json({ error: 'WhatsApp not connected' });

    let sent = 0;
    for (const jid of jids) {
      try {
        await sock.sendMessage(jid, { text: message });
        sent++;
        await delay(800);
      } catch (_) {}
    }

    res.json({ ok: true, sent, total: jids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  CUSTOMERS
// ============================================================
router.get('/client/customers', auth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('customers').select('*').eq('client_id', req.clientId)
      .order('last_contact', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  SETTINGS
// ============================================================
router.get('/client/settings', auth, async (req, res) => {
  try {
    const client = await getClient(req.clientId);
    const { data: setup } = await supabase
      .from('bot_setup')
      .select('instagram,facebook,tiktok,whatsapp_channel,payment_methods,current_promo,return_policy')
      .eq('client_id', req.clientId).single();

    res.json({
      business_name:       client.business_name,
      name_last_changed:   client.name_last_changed,
      email:               client.email,
      phone:               client.phone,
      business_type:       client.business_type,
      business_hours:      client.business_hours,
      fallback_message:    client.fallback_message,
      notification_number: client.notification_number,
      bank_name:           client.bank_name,
      account_number:      client.account_number,
      account_name:        client.account_name,
      ...(setup || {})
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/client/settings', auth, async (req, res) => {
  try {
    const clientId = req.clientId;
    const {
      business_name, business_hours, fallback_message, notification_number,
      bank_name, account_number, account_name, business_type
    } = req.body;

    const updatePayload = {
      business_hours, fallback_message, notification_number,
      bank_name, account_number, account_name, business_type
    };

    // 30-day business name lock
    if (business_name) {
      const client = await getClient(clientId);
      const lastChanged    = client.name_last_changed ? new Date(client.name_last_changed) : null;
      const thirtyDaysAgo  = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      if (!lastChanged || lastChanged < thirtyDaysAgo) {
        updatePayload.business_name     = business_name;
        updatePayload.name_last_changed = new Date().toISOString();
      }
    }

    const { error } = await supabase.from('clients').update(updatePayload).eq('id', clientId);
    if (error) throw error;

    // Also update socials / promo in bot_setup if provided
    const setupFields = ['instagram','facebook','tiktok','whatsapp_channel','payment_methods','current_promo','return_policy'];
    const setupUpdate = {};
    setupFields.forEach(f => { if (req.body[f] !== undefined) setupUpdate[f] = req.body[f]; });

    if (Object.keys(setupUpdate).length) {
      setupUpdate.updated_at = new Date().toISOString();
      await supabase.from('bot_setup').upsert(
        { client_id: clientId, ...setupUpdate },
        { onConflict: 'client_id' }
      );
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  DASHBOARD STATS  (called every 20 s by dashboard polling)
//  GET /api/client/stats
// ============================================================
router.get('/client/stats', auth, async (req, res) => {
  try {
    const cid   = req.clientId;
    const since = req.query.since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [orders, inquiries, customers] = await Promise.all([
      supabase.from('orders').select('id,status,payment_status').eq('client_id', cid),
      supabase.from('price_inquiries').select('id').eq('client_id', cid).gte('created_at', since),
      supabase.from('customers').select('id').eq('client_id', cid)
    ]);

    res.json({
      pending:        (orders.data || []).filter(o => o.status === 'pending').length,
      unpaid:         (orders.data || []).filter(o => o.payment_status === 'unpaid' && o.status !== 'cancelled').length,
      newLeads:       (inquiries.data || []).length,
      totalCustomers: (customers.data || []).length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  PUSH NOTIFICATIONS
// ============================================================
router.get('/push/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

router.post('/push/subscribe', auth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }
    await supabase.from('push_subscriptions').upsert({
      client_id: req.clientId,
      endpoint,
      p256dh: keys.p256dh,
      auth:   keys.auth
    }, { onConflict: 'client_id,endpoint' });

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/push/test', auth, async (req, res) => {
  try {
    const subs = await getClientSubscriptions(req.clientId);
    if (!subs.length) return res.status(404).json({ error: 'No subscriptions found' });

    await sendPushToClient(subs, JSON.stringify({
      title: '🔔 ForgeBot Alerts are ON',
      body:  'You will now get instant alerts for orders and inquiries!',
      icon:  '/icons/icon-192.png',
      url:   '/dashboard?token=' + req.token
    }));

    res.json({ ok: true, sent: subs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ============================================================
//  INTERNAL HELPERS  (also exported for replyEngine.js)
// ============================================================
async function sendPushToClient(subscriptions, payloadStr) {
  const results = await Promise.allSettled(subscriptions.map(sub =>
    webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      payloadStr
    )
  ));

  // Remove expired subscriptions (410 Gone)
  const gone = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && r.reason?.statusCode === 410) gone.push(subscriptions[i].endpoint);
  });
  if (gone.length) await supabase.from('push_subscriptions').delete().in('endpoint', gone);
}

async function getClientSubscriptions(clientId) {
  const { data } = await supabase.from('push_subscriptions').select('*').eq('client_id', clientId);
  return data || [];
}

// Called from replyEngine.js:  pushToClient(clientId, title, body, url)
async function pushToClient(clientId, title, body, url) {
  try {
    const subs = await getClientSubscriptions(clientId);
    if (!subs.length) return;
    await sendPushToClient(subs, JSON.stringify({
      title, body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', url
    }));
  } catch (e) { console.error('push error', e.message); }
}

async function notifyCustomerOrderStatus(order) {
  try {
    const sock = getSock(order.client_id);
    if (!sock) return;
    const msgMap = {
      accepted:    '✅ Great news! Your order has been *accepted* and is being prepared.',
      in_delivery: '🚚 Your order is now *on the way*! Expect delivery soon.',
      delivered:   '📦 Your order has been *delivered*! Thank you for shopping with us.',
      completed:   '✅ Your booking is *confirmed* and completed. Thank you!',
      cancelled:   '❌ Your order has been *cancelled*. Contact us if you have questions.'
    };
    const msg = msgMap[order.status];
    if (msg) await sock.sendMessage(order.customer_jid, { text: msg });
  } catch (_) {}
}

async function notifyCustomerPayment(order, action) {
  try {
    const sock = getSock(order.client_id);
    if (!sock) return;
    const msg = action === 'confirm'
      ? '✅ Your payment has been *confirmed*! Your order is now being processed.'
      : '❌ We could not verify your payment receipt. Please resend a clear screenshot of your transfer or contact us directly.';
    await sock.sendMessage(order.customer_jid, { text: msg });
  } catch (_) {}
}

// ============================================================
module.exports = router;
module.exports.pushToClient            = pushToClient;
module.exports.getClientSubscriptions  = getClientSubscriptions;
