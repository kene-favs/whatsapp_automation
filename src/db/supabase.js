// src/db/supabase.js
// Lazy init — does NOT crash on boot if env vars are missing
const { createClient } = require('@supabase/supabase-js');

let _supabase = null;

function getSupabase() {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    _supabase = createClient(url, key);
  }
  return _supabase;
}

module.exports = getSupabase();
