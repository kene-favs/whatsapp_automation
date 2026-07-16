const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const OPENAI_KEY = process.env.OPENAI_API_KEY;

async function transcribeVoiceNote(sock, msg) {
  if (!OPENAI_KEY) {
    console.warn('[VoiceHandler] No OPENAI_API_KEY set -- skipping transcription');
    return null;
  }
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    if (!buffer) return null;

    const tmpPath = path.join('/tmp', 'voice_' + Date.now() + '.ogg');
    fs.writeFileSync(tmpPath, buffer);

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath), {
      filename: 'audio.ogg',
      contentType: 'audio/ogg'
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    // No language hint -- Whisper auto-detects Yoruba, Igbo, Hausa, Pidgin, English

    const response = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: 'Bearer ' + OPENAI_KEY
        },
        timeout: 30000
      }
    );

    fs.unlinkSync(tmpPath);
    const text = response.data && response.data.trim ? response.data.trim() : null;
    console.log('[VoiceHandler] Transcribed: "' + text + '"');
    return text || null;
  } catch (err) {
    console.error('[VoiceHandler] Transcription failed:', err.message);
    return null;
  }
}

module.exports = { transcribeVoiceNote };
