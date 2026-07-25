// ============================================================
//  clientRoutes.js — TWO TARGETED CHANGES ONLY
//  Do NOT overwrite the file. Make exactly these two edits:
//
//  CHANGE 1: Find this line in PUT /client/settings:
//    var allowed = ['notification_number', 'business_name', 'bank_name', 'account_number', 'account_name', 'business_hours'];
//  Replace with:
//    var allowed = ['notification_number', 'business_name', 'welcome_message', 'fallback_message', 'bank_name', 'account_number', 'account_name', 'business_hours'];
//
//  CHANGE 2: Paste the block below just ABOVE the final line:
//    module.exports = router;
// ============================================================

// ── GET /api/client/settings ─────────────────────────────────
// Returns all saved settings so the dashboard can pre-fill fields
router.get('/client/settings', async function(req, res) {
  try {
    var sb = getSupabase();

    // Read client row
    var clientRes = await sb.from('clients').select('*').eq('id', req.clientId).single();
    if (clientRes.error || !clientRes.data) return res.status(404).json({ error: 'Client not found' });
    var client = clientRes.data;
    delete client.password_hash; // never expose

    // Read bot_setup row (may not exist yet)
    var setupRes = await sb.from('bot_setup').select('*').eq('client_id', req.clientId).single();
    var setup    = (setupRes.data) || {};

    res.json({
      // ── Basic settings (saved via PUT /client/settings) ──
      notification_number: client.notification_number || '',
      business_name:       client.business_name       || '',
      welcome_message:     client.welcome_message     || '',
      fallback_message:    client.fallback_message    || '',
      bank_name:           client.bank_name           || '',
      account_number:      client.account_number      || '',
      account_name:        client.account_name        || '',
      business_hours:      client.business_hours      || '',
      // ── Social media / delivery (saved via PUT /client/bot-setup) ──
      instagram:           setup.instagram            || '',
      facebook:            setup.facebook             || '',
      tiktok:              setup.tiktok               || '',
      whatsapp_channel:    setup.whatsapp_channel     || '',
      service_areas:       setup.service_areas        || '',
      delivers_to:         setup.delivers_to          || '',
      delivery_fee_local:  setup.delivery_fee_local   || '',
      delivery_time_local: setup.delivery_time_local  || '',
      minimum_order:       setup.minimum_order        || '',
      return_policy:       setup.return_policy        || '',
      current_promo:       setup.current_promo        || '',
      payment_methods:     setup.payment_methods      || [],
      // ── Subscription info ──
      subscription_active: client.subscription_active || false,
      is_partner:          client.is_partner          || false,
      partner_expires_at:  client.partner_expires_at  || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
