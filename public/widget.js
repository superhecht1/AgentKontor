/**
 * AgentKontor Widget v2
 * Lädt Konfiguration vom Server: position, delay, theme, size
 *
 * Einbindung:
 *   <script>window.AK_AGENT_ID = "DEINE_PUBLIC_ID";</script>
 *   <script src="https://agentkontor.de/widget.js"></script>
 */
(function () {
  'use strict';

  const AGENT_ID = window.AK_AGENT_ID;
  if (!AGENT_ID) { console.warn('[AgentKontor] window.AK_AGENT_ID nicht gesetzt'); return; }

  const BASE_URL = (function () {
    const s = document.currentScript;
    if (s && s.src) return s.src.replace('/widget.js', '');
    return 'https://agentkontor.de';
  })();

  // ── FETCH AGENT CONFIG ────────────────────────────────
  async function loadConfig() {
    try {
      const r = await fetch(`${BASE_URL}/api/chat/widget-config/${AGENT_ID}`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // ── BUILD WIDGET ──────────────────────────────────────
  async function init() {
    const cfg = await loadConfig();
    if (!cfg || !cfg.widget_enabled) return;

    const position  = cfg.widget_position || 'right';   // 'right' | 'left'
    const delay     = parseInt(cfg.widget_delay)  || 0; // seconds before auto-open
    const theme     = cfg.widget_theme   || 'dark';     // 'dark' | 'light'
    const size      = parseInt(cfg.widget_size)   || 56;
    const color     = cfg.color          || '#6c5ce7';
    const emoji     = cfg.emoji          || '💬';
    const name      = cfg.name           || 'Agent';
    const greeting  = cfg.greeting       || 'Hallo! Wie kann ich helfen?';

    const isLight   = theme === 'light';
    const bg        = isLight ? '#ffffff' : '#0c0c1e';
    const bgMsg     = isLight ? '#f4f4f8' : '#1e1e38';
    const textColor = isLight ? '#1a1a2e' : '#e0e0f0';
    const mutedColor = isLight ? '#888' : '#8888aa';
    const borderClr = isLight ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.08)';
    const inputBg   = isLight ? '#f4f4f8' : 'rgba(255,255,255,.06)';

    const hSide = position === 'left' ? 'left:20px' : 'right:20px';

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #ak-widget-btn {
        position:fixed; bottom:20px; ${hSide}; width:${size}px; height:${size}px;
        border-radius:50%; background:${color}; border:none; cursor:pointer;
        box-shadow:0 4px 20px rgba(0,0,0,.3); z-index:2147483646;
        font-size:${Math.round(size*0.42)}px; display:flex; align-items:center; justify-content:center;
        transition:transform .2s,box-shadow .2s;
      }
      #ak-widget-btn:hover { transform:scale(1.08); box-shadow:0 6px 28px rgba(0,0,0,.4); }
      #ak-widget-btn .ak-badge {
        position:absolute; top:-2px; right:-2px; width:14px; height:14px;
        background:#e94560; border-radius:50%; border:2px solid ${bg}; display:none;
      }
      #ak-widget-frame {
        position:fixed; bottom:${size+30}px; ${hSide};
        width:360px; height:520px; max-height:calc(100vh - 120px);
        background:${bg}; border:1px solid ${borderClr};
        border-radius:16px; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.35);
        z-index:2147483645; display:none; flex-direction:column;
        font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        transition:opacity .2s,transform .2s;
        opacity:0; transform:translateY(12px) scale(.97);
      }
      #ak-widget-frame.open { opacity:1; transform:translateY(0) scale(1); }
      .ak-hdr {
        padding:12px 14px; display:flex; align-items:center; gap:10px;
        border-bottom:1px solid ${borderClr};
        background:${color}18;
      }
      .ak-av { width:34px; height:34px; border-radius:50%; background:${color}33;
        display:flex; align-items:center; justify-content:center; font-size:1rem; flex-shrink:0; }
      .ak-hdr-name { font-size:.88rem; font-weight:700; color:${textColor}; }
      .ak-hdr-status { font-size:.68rem; color:#00b894; }
      .ak-close { margin-left:auto; background:none; border:none; cursor:pointer;
        color:${mutedColor}; font-size:1.1rem; padding:2px 6px; border-radius:5px; }
      .ak-close:hover { background:${inputBg}; }
      .ak-msgs { flex:1; overflow-y:auto; padding:12px; display:flex;
        flex-direction:column; gap:9px; scroll-behavior:smooth; }
      .ak-msgs::-webkit-scrollbar { width:4px; }
      .ak-msgs::-webkit-scrollbar-thumb { background:${borderClr}; border-radius:2px; }
      .ak-bbl { max-width:82%; padding:9px 12px; border-radius:12px;
        font-size:.82rem; line-height:1.55; word-break:break-word; }
      .ak-bbl.bot { background:${bgMsg}; color:${textColor}; border-bottom-left-radius:2px; align-self:flex-start; }
      .ak-bbl.usr { background:${color}; color:#fff; border-bottom-right-radius:2px; align-self:flex-end; }
      .ak-bbl.typing { padding:11px 14px; }
      .ak-dot { display:inline-block; width:6px; height:6px; border-radius:50%;
        background:${mutedColor}; animation:ak-bounce .9s infinite; margin:0 2px; }
      .ak-dot:nth-child(2){animation-delay:.15s}.ak-dot:nth-child(3){animation-delay:.3s}
      @keyframes ak-bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}
      .ak-chips { display:flex; flex-wrap:wrap; gap:5px; padding:0 12px 8px; }
      .ak-chip { background:${inputBg}; border:1px solid ${borderClr}; border-radius:20px;
        padding:4px 11px; font-size:.74rem; color:${textColor}; cursor:pointer; transition:all .15s; }
      .ak-chip:hover { border-color:${color}; color:${color}; }
      .ak-foot { padding:10px 12px; border-top:1px solid ${borderClr}; display:flex; gap:7px; }
      .ak-input { flex:1; background:${inputBg}; border:1px solid ${borderClr}; border-radius:9px;
        padding:8px 12px; color:${textColor}; font-size:.82rem; outline:none; font-family:inherit; resize:none; }
      .ak-input:focus { border-color:${color}; }
      .ak-input::placeholder { color:${mutedColor}; }
      .ak-send { width:36px; height:36px; border-radius:9px; background:${color}; border:none;
        cursor:pointer; color:#fff; font-size:.9rem; display:flex; align-items:center; justify-content:center;
        flex-shrink:0; transition:filter .2s; }
      .ak-send:hover { filter:brightness(1.15); }
      .ak-powered { text-align:center; font-size:.62rem; color:${mutedColor}; padding:4px 0 6px; }
      .ak-powered a { color:${mutedColor}; text-decoration:none; }
      .ak-powered a:hover { color:${color}; }
      @media(max-width:420px){
        #ak-widget-frame { width:calc(100vw - 20px); ${position==='left'?'left:10px':'right:10px'}; }
      }
    `;
    document.head.appendChild(style);

    // Button
    const btn = document.createElement('button');
    btn.id = 'ak-widget-btn';
    btn.setAttribute('aria-label', `Chat mit ${name} öffnen`);
    btn.innerHTML = `<span class="ak-emoji">${emoji}</span><span class="ak-badge"></span>`;
    document.body.appendChild(btn);

    // Frame
    const frame = document.createElement('div');
    frame.id = 'ak-widget-frame';
    frame.setAttribute('role', 'dialog');
    frame.setAttribute('aria-label', `${name} Chat`);
    frame.innerHTML = `
      <div class="ak-hdr">
        <div class="ak-av">${emoji}</div>
        <div><div class="ak-hdr-name">${name}</div><div class="ak-hdr-status">● Online</div></div>
        <button class="ak-close" aria-label="Schließen">✕</button>
      </div>
      <div class="ak-msgs" id="ak-msgs"></div>
      <div class="ak-chips" id="ak-chips"></div>
      <div class="ak-foot">
        <textarea class="ak-input" id="ak-input" placeholder="Nachricht…" rows="1"></textarea>
        <button class="ak-send" id="ak-send" aria-label="Senden">➤</button>
      </div>
      <div class="ak-powered">Powered by <a href="https://agentkontor.de" target="_blank">AgentKontor</a></div>
    `;
    document.body.appendChild(frame);

    // State
    let open = false;
    let sessionId = null;
    let history = [];
    const msgs  = document.getElementById('ak-msgs');
    const input = document.getElementById('ak-input');
    const send  = document.getElementById('ak-send');
    const chips = document.getElementById('ak-chips');
    const badge = btn.querySelector('.ak-badge');

    function toggleOpen(force) {
      open = force !== undefined ? force : !open;
      if (open) {
        frame.style.display = 'flex';
        requestAnimationFrame(() => frame.classList.add('open'));
        btn.querySelector('.ak-emoji').textContent = '✕';
        badge.style.display = 'none';
        input.focus();
        if (!msgs.children.length) addBot(greeting, cfg.quick_chips || []);
      } else {
        frame.classList.remove('open');
        setTimeout(() => frame.style.display = 'none', 200);
        btn.querySelector('.ak-emoji').textContent = emoji;
      }
    }

    function addBot(text, quickChips = []) {
      const d = document.createElement('div');
      d.className = 'ak-bbl bot';
      d.textContent = text;
      msgs.appendChild(d);
      chips.innerHTML = '';
      (quickChips || []).forEach(c => {
        const b = document.createElement('button');
        b.className = 'ak-chip'; b.textContent = c;
        b.onclick = () => { input.value = c; doSend(); };
        chips.appendChild(b);
      });
      msgs.scrollTop = msgs.scrollHeight;
    }

    function addUser(text) {
      chips.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'ak-bbl usr'; d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
    }

    function showTyping() {
      const d = document.createElement('div');
      d.className = 'ak-bbl bot typing'; d.id = 'ak-typing';
      d.innerHTML = '<span class="ak-dot"></span><span class="ak-dot"></span><span class="ak-dot"></span>';
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
      return d;
    }

    // Persistent session identifier (stored in localStorage)
    const SESSION_KEY = `ak_sid_${AGENT_ID}`;
    let sessionIdentifier = localStorage.getItem(SESSION_KEY);
    if (!sessionIdentifier) {
      sessionIdentifier = 'w_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem(SESSION_KEY, sessionIdentifier);
    }

    // Image upload support
    let pendingImage = null;
    const imgBtn = document.createElement('label');
    imgBtn.innerHTML = '📎';
    imgBtn.title = 'Bild senden';
    imgBtn.style.cssText = 'width:34px;height:34px;border-radius:9px;background:' + inputBg + ';border:1px solid ' + borderClr + ';display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:1rem;flex-shrink:0';
    const imgInput = document.createElement('input');
    imgInput.type = 'file'; imgInput.accept = 'image/*'; imgInput.style.display = 'none';
    imgBtn.appendChild(imgInput);
    frame.querySelector('.ak-foot').insertBefore(imgBtn, send);

    imgInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = reader.result.split(',')[1];
        pendingImage = { type: 'image', source: { type: 'base64', media_type: file.type, data: b64 } };
        imgBtn.innerHTML = '🖼️';
      };
      reader.readAsDataURL(file);
    });

    async function doSend() {
      const text = input.value.trim();
      if (!text && !pendingImage) return;
      input.value = ''; input.style.height = 'auto';

      // Build message content (multimodal if image present)
      let content;
      if (pendingImage && text) {
        content = [pendingImage, { type: 'text', text }];
      } else if (pendingImage) {
        content = [pendingImage, { type: 'text', text: 'Was siehst du auf diesem Bild?' }];
      } else {
        content = text;
      }

      addUser(typeof content === 'string' ? content : '📎 ' + (text || 'Bild'));
      history.push({ role: 'user', content });
      pendingImage = null; imgBtn.innerHTML = '📎';

      send.disabled = true;
      const typing = showTyping();

      // Try streaming first, fall back to standard
      try {
        const r = await fetch(`${BASE_URL}/api/chat/stream/${AGENT_ID}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: history, sessionId, source: 'widget', sessionIdentifier }),
        });

        if (!r.ok || !r.headers.get('content-type')?.includes('text/event-stream')) {
          // Fallback to standard
          const d = await r.json();
          typing.remove();
          const reply = d.reply || d.error || 'Fehler';
          sessionId = d.sessionId || sessionId;
          history.push({ role: 'assistant', content: reply });
          addBot(reply);
          send.disabled = false;
          if (!open) badge.style.display = 'block';
          return;
        }

        // Stream
        typing.remove();
        const botEl = document.createElement('div');
        botEl.className = 'ak-bbl bot';
        botEl.textContent = '';
        msgs.appendChild(botEl);
        msgs.scrollTop = msgs.scrollHeight;

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let fullText = '';
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type === 'session') sessionId = ev.sessionId;
              if (ev.type === 'text') { fullText += ev.text; botEl.textContent = fullText; msgs.scrollTop = msgs.scrollHeight; }
            } catch {}
          }
        }

        history.push({ role: 'assistant', content: fullText });
        chips.innerHTML = '';
        speakReply(fullText);
        if (!open) badge.style.display = 'block';
      } catch {
        if (typing.parentNode) typing.remove();
        addBot('Verbindungsfehler. Bitte versuche es erneut.');
      }
      send.disabled = false;
    }

    // Voice button
    const voiceBtn = document.createElement('button');
    voiceBtn.style.cssText = `width:34px;height:34px;border-radius:9px;background:${inputBg};border:1px solid ${borderClr};display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:1rem;flex-shrink:0`;
    voiceBtn.innerHTML = '🎤';
    voiceBtn.title = 'Spracheingabe';
    frame.querySelector('.ak-foot').insertBefore(voiceBtn, send);

    let mediaRecorder = null;
    let audioChunks   = [];
    let isRecording   = false;

    voiceBtn.addEventListener('click', async () => {
      if (!isRecording) {
        // Start recording
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          audioChunks = [];
          mediaRecorder = new MediaRecorder(stream);
          mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
          mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            voiceBtn.innerHTML = '⏳';
            voiceBtn.disabled = true;

            // Transcribe
            const fd = new FormData();
            fd.append('audio', blob, 'recording.webm');
            fd.append('language', 'de');

            try {
              const r = await fetch(`${BASE_URL}/api/voice/transcribe`, { method: 'POST', body: fd });
              const d = await r.json();
              if (d.text) {
                input.value = d.text;
                input.dispatchEvent(new Event('input'));
                // Auto-send after transcription
                setTimeout(() => doSend(), 300);
              }
            } catch(e) {
              console.error('Transcribe error:', e);
            }
            voiceBtn.innerHTML = '🎤';
            voiceBtn.disabled = false;
          };
          mediaRecorder.start();
          isRecording = true;
          voiceBtn.innerHTML = '⏹️';
          voiceBtn.style.background = '#e94560';
        } catch(e) {
          console.error('Microphone error:', e);
          voiceBtn.title = 'Mikrofon-Zugriff verweigert';
        }
      } else {
        // Stop recording
        mediaRecorder?.stop();
        isRecording = false;
        voiceBtn.innerHTML = '🎤';
        voiceBtn.style.background = inputBg;
      }
    });

    // TTS: speak bot replies if voice enabled
    async function speakReply(text) {
      if (!cfg.voice_enabled) return;
      try {
        const r = await fetch(`${BASE_URL}/api/voice/speak`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voiceId: cfg.voice_id, provider: cfg.voice_provider || 'elevenlabs' }),
        });
        if (!r.ok || r.headers.get('content-type')?.includes('json')) return; // fallback
        const blob = await r.blob();
        const url  = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.play().catch(() => {});
      } catch {}
    }

    // Events
    btn.addEventListener('click', () => toggleOpen());
    frame.querySelector('.ak-close').addEventListener('click', () => toggleOpen(false));
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 100) + 'px';
    });

    // GDPR consent text (shown before lead capture)
    const consentText = cfg.lead_consent_text ||
      'Ich stimme zu, dass meine Daten zum Zweck der Kontaktaufnahme gespeichert werden. Details: Datenschutzerklärung.';

    // Show consent before lead data is captured
    let consentGiven = false;
    function showConsentBanner() {
      const banner = document.createElement('div');
      banner.style.cssText = `padding:12px;background:${inputBg};border-top:1px solid ${borderClr};font-size:.75rem;color:${mutedColor};line-height:1.5`;
      banner.innerHTML = `<p style="margin-bottom:8px">${consentText}</p>
        <div style="display:flex;gap:8px">
          <button onclick="this.parentElement.parentElement.remove();window._akConsent=true;" style="padding:5px 12px;background:${color};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:.75rem">Zustimmen</button>
          <button onclick="this.parentElement.parentElement.remove();" style="padding:5px 12px;background:transparent;border:1px solid ${borderClr};border-radius:6px;cursor:pointer;font-size:.75rem;color:${mutedColor}">Ablehnen</button>
        </div>`;
      frame.appendChild(banner);
    }
    window._akConsent = false;

    // Auto-open after delay
    if (delay > 0) {
      setTimeout(() => { if (!open) toggleOpen(true); }, delay * 1000);
    }

    // Keyboard: Escape closes
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && open) toggleOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
