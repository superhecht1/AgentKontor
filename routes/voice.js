/**
 * AgentKontor — Voice API
 *
 * POST /api/voice/transcribe  — Audio → Text (Whisper)
 * POST /api/voice/speak       — Text → Audio (ElevenLabs)
 * GET  /api/voice/voices      — List ElevenLabs voices
 */

const router = require('express').Router();
const auth   = require('../middleware/auth');
const multer = require('multer');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg', 'audio/x-m4a'];
    cb(null, allowed.includes(file.mimetype) || file.originalname.match(/\.(webm|mp4|ogg|wav|mp3|m4a)$/i));
  },
});

/* ── TRANSCRIBE (STT) ───────────────────────────────────── */
router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Audio-Datei erforderlich' });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OpenAI API-Key nicht konfiguriert' });

  try {
    const OpenAI   = require('openai');
    const { Readable } = require('stream');
    const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Convert buffer to File-like object
    const audioFile = new File(
      [req.file.buffer],
      req.file.originalname || 'audio.webm',
      { type: req.file.mimetype || 'audio/webm' }
    );

    const transcription = await openai.audio.transcriptions.create({
      file:     audioFile,
      model:    'whisper-1',
      language: req.body.language || 'de',
      response_format: 'json',
    });

    res.json({ text: transcription.text, language: req.body.language || 'de' });
  } catch(e) {
    console.error('Transcribe error:', e.message);
    res.status(500).json({ error: 'Transkription fehlgeschlagen' });
  }
});

/* ── TEXT-TO-SPEECH ─────────────────────────────────────── */
router.post('/speak', async (req, res) => {
  const { text, voiceId, provider = 'elevenlabs', agentId } = req.body;
  if (!text) return res.status(400).json({ error: 'Text erforderlich' });

  const cleanText = text.slice(0, 2000); // limit

  if (provider === 'elevenlabs') {
    if (!process.env.ELEVENLABS_API_KEY) {
      return res.status(503).json({ error: 'ElevenLabs API-Key nicht konfiguriert', fallback: true });
    }

    try {
      const vid  = voiceId || process.env.ELEVENLABS_DEFAULT_VOICE || 'pNInz6obpgDQGcFmaJgB'; // Adam
      const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: 'POST',
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_multilingual_v2',
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error('ElevenLabs error:', err);
        return res.status(502).json({ error: 'TTS-Fehler', fallback: true });
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const buf = await resp.arrayBuffer();
      res.send(Buffer.from(buf));
    } catch(e) {
      console.error('TTS error:', e.message);
      res.status(500).json({ error: 'TTS fehlgeschlagen', fallback: true });
    }
  } else if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OpenAI nicht konfiguriert', fallback: true });
    try {
      const OpenAI = require('openai');
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const mp3    = await openai.audio.speech.create({
        model: 'tts-1', voice: 'nova', input: cleanText,
      });
      res.setHeader('Content-Type', 'audio/mpeg');
      const buf = Buffer.from(await mp3.arrayBuffer());
      res.send(buf);
    } catch(e) {
      res.status(500).json({ error: 'TTS fehlgeschlagen', fallback: true });
    }
  } else {
    res.status(400).json({ error: 'Unbekannter Provider' });
  }
});

/* ── LIST ELEVENLABS VOICES ─────────────────────────────── */
router.get('/voices', auth, async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.json({ voices: [] });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    });
    const d = await r.json();
    res.json({ voices: (d.voices || []).map(v => ({ id: v.voice_id, name: v.name, preview: v.preview_url })) });
  } catch(e) {
    res.json({ voices: [] });
  }
});

module.exports = router;
