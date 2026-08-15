/**
 * AgentKontor — DSGVO Cookie-Banner
 * Einbinden in alle HTML-Seiten vor </body>:
 *   <script src="/cookie-banner.js"></script>
 *
 * Speichert Einwilligung in localStorage.
 * Kein Tracking ohne Einwilligung.
 */
(function () {
  'use strict';

  const KEY     = 'ak_cookie_consent';
  const VERSION = '1'; // Increment to re-ask consent

  if (localStorage.getItem(KEY) === VERSION) return; // already consented

  const style = `
    #ak-cookie{position:fixed;bottom:0;left:0;right:0;z-index:99999;
      background:#1a1916;border-top:1px solid rgba(255,255,255,.1);
      padding:16px 24px;display:flex;align-items:center;gap:16px;
      flex-wrap:wrap;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      box-shadow:0 -4px 24px rgba(0,0,0,.3);animation:akSlideUp .3s ease}
    @keyframes akSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
    #ak-cookie p{font-size:.82rem;color:rgba(255,255,255,.7);margin:0;flex:1;min-width:260px;line-height:1.6}
    #ak-cookie a{color:#a29bfe;text-decoration:underline}
    #ak-cookie .ak-cb-btns{display:flex;gap:8px;flex-shrink:0}
    #ak-cookie button{padding:8px 18px;border-radius:8px;font-size:.82rem;font-weight:600;
      border:none;cursor:pointer;font-family:inherit;transition:all .2s}
    #ak-cookie .ak-accept{background:#6c5ce7;color:#fff}
    #ak-cookie .ak-accept:hover{background:#a29bfe}
    #ak-cookie .ak-decline{background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)}
    #ak-cookie .ak-decline:hover{background:rgba(255,255,255,.15)}
  `;

  const el = document.createElement('div');
  el.id = 'ak-cookie';
  el.innerHTML = `
    <style>${style}</style>
    <p>
      Wir nutzen Cookies und externe Dienste (CDN, Analytics) um diese Seite zu betreiben.
      Mit Klick auf "Akzeptieren" stimmst du dem zu.
      <a href="/cookie-richtlinie.html">Mehr erfahren</a> ·
      <a href="/datenschutz.html">Datenschutz</a>
    </p>
    <div class="ak-cb-btns">
      <button class="ak-decline" id="ak-cb-decline">Ablehnen</button>
      <button class="ak-accept" id="ak-cb-accept">Akzeptieren</button>
    </div>
  `;

  function accept() {
    localStorage.setItem(KEY, VERSION);
    el.style.animation = 'akSlideDown .3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }

  function decline() {
    // Still record that user has seen and declined
    localStorage.setItem(KEY, 'declined');
    el.remove();
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.body.appendChild(el);
    document.getElementById('ak-cb-accept').addEventListener('click', accept);
    document.getElementById('ak-cb-decline').addEventListener('click', decline);
  });

  if (document.readyState !== 'loading') {
    document.body.appendChild(el);
    document.getElementById('ak-cb-accept')?.addEventListener('click', accept);
    document.getElementById('ak-cb-decline')?.addEventListener('click', decline);
  }
})();
