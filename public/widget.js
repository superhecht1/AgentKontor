/* AgentKontor Widget - embed with:
   <script>window.AK_AGENT_ID="your_public_id";</script>
   <script src="https://your-app.onrender.com/widget.js"></script>
*/
(function(){
  const AGENT_ID = window.AK_AGENT_ID;
  const BASE = (window.AK_BASE_URL || '').replace(/\/$/, '');
  if (!AGENT_ID) return;

  let agent = null, open = false, typing = false;
  let messages = [], sessionId = 'wgt_' + Math.random().toString(36).slice(2,10);

  // Styles
  const css = document.createElement('style');
  css.textContent = `
    #ak-btn{position:fixed;bottom:24px;right:24px;z-index:9990;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;font-size:1.4rem;transition:transform .2s,box-shadow .2s}
    #ak-btn:hover{transform:scale(1.08)}
    #ak-win{position:fixed;bottom:92px;right:24px;z-index:9991;width:360px;height:520px;max-height:calc(100vh-110px);border-radius:16px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4);transform:scale(.9) translateY(10px);opacity:0;transition:all .25s cubic-bezier(.34,1.56,.64,1);pointer-events:none;background:#0f0f1e;border:1px solid rgba(255,255,255,.1)}
    #ak-win.ak-open{transform:scale(1) translateY(0);opacity:1;pointer-events:all}
    .ak-hdr{padding:12px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
    .ak-av{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1rem}
    .ak-nm{font-size:.9rem;font-weight:700;color:#fff}
    .ak-st{font-size:.68rem;color:#00cec9}
    .ak-close{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.6);font-size:1rem;cursor:pointer;padding:4px;border-radius:6px}
    .ak-close:hover{background:rgba(255,255,255,.1)}
    .ak-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
    .ak-msgs::-webkit-scrollbar{width:3px}
    .ak-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}
    .ak-msg{display:flex;gap:7px;max-width:90%}
    .ak-msg.ak-u{align-self:flex-end;flex-direction:row-reverse}
    .ak-mav{width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;flex-shrink:0;margin-top:2px;background:rgba(255,255,255,.08)}
    .ak-bbl{padding:8px 12px;border-radius:12px;font-size:.83rem;line-height:1.5;word-break:break-word;white-space:pre-wrap}
    .ak-msg.ak-a .ak-bbl{background:#1e1e38;color:#e0e0f0;border-bottom-left-radius:2px}
    .ak-msg.ak-u .ak-bbl{color:#fff;border-bottom-right-radius:2px}
    .ak-typ{display:flex;gap:3px;padding:8px 12px;background:#1e1e38;border-radius:12px;border-bottom-left-radius:2px}
    .ak-typ span{width:6px;height:6px;border-radius:50%;background:#a29bfe;animation:akBounce .8s infinite}
    .ak-typ span:nth-child(2){animation-delay:.15s}.ak-typ span:nth-child(3){animation-delay:.3s}
    @keyframes akBounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-7px)}}
    .ak-chips{display:flex;flex-wrap:wrap;gap:5px;padding:0 14px 10px}
    .ak-chip{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:4px 11px;font-size:.73rem;cursor:pointer;color:#d0d0e8;transition:all .2s}
    .ak-chip:hover{background:rgba(108,92,231,.2);color:#fff}
    .ak-foot{padding:10px 14px;border-top:1px solid rgba(255,255,255,.07);display:flex;gap:7px;flex-shrink:0}
    .ak-inp{flex:1;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 12px;color:#e0e0f0;font-size:.83rem;resize:none;line-height:1.4;max-height:80px;font-family:inherit}
    .ak-inp:focus{outline:none}
    .ak-send{width:34px;height:34px;border-radius:8px;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.85rem;flex-shrink:0}
    .ak-send:disabled{opacity:.4;cursor:not-allowed}
    .ak-pwd{text-align:center;font-size:.6rem;color:rgba(255,255,255,.15);padding:4px;flex-shrink:0}
    @media(max-width:480px){#ak-win{width:calc(100vw-20px);right:10px;bottom:84px}#ak-btn{right:16px;bottom:16px}}
  `;
  document.head.appendChild(css);

  // DOM
  const btn = document.createElement('button'); btn.id='ak-btn';
  const win = document.createElement('div'); win.id='ak-win';
  win.innerHTML = `
    <div class="ak-hdr" id="ak-hdr"></div>
    <div class="ak-msgs" id="ak-msgs"></div>
    <div class="ak-chips" id="ak-chips"></div>
    <div class="ak-foot">
      <textarea class="ak-inp" id="ak-inp" rows="1" placeholder="Nachricht..."></textarea>
      <button class="ak-send" id="ak-send" disabled>➤</button>
    </div>
    <div class="ak-pwd">Powered by AgentKontor</div>
  `;
  document.body.append(btn, win);

  const msgsEl = document.getElementById('ak-msgs');
  const inpEl  = document.getElementById('ak-inp');
  const sndBtn = document.getElementById('ak-send');

  // Load agent
  fetch(`${BASE}/api/agents/public/${AGENT_ID}`).then(r=>r.json()).then(d=>{
    if (!d.agent) return;
    agent = d.agent;
    document.documentElement.style.setProperty('--ak-c', agent.color);
    btn.style.background = agent.color;
    btn.textContent = agent.emoji;
    sndBtn.style.background = agent.color;

    document.getElementById('ak-hdr').innerHTML = `
      <div class="ak-av" style="background:${agent.color}22">${agent.emoji}</div>
      <div><div class="ak-nm">${agent.name}</div><div class="ak-st">● Online</div></div>
      <button class="ak-close" id="ak-cls">✕</button>
    `;
    document.getElementById('ak-cls').onclick = toggle;

    // Welcome message
    addMsg('assistant', agent.greeting);

    // Chips
    if (agent.quick_chips?.length) {
      const el = document.getElementById('ak-chips');
      el.innerHTML = agent.quick_chips.map(c =>
        `<span class="ak-chip">${esc(c)}</span>`
      ).join('');
      el.querySelectorAll('.ak-chip').forEach(ch => {
        ch.onclick = () => { sendText(ch.textContent); el.innerHTML=''; };
      });
    }
    btn.style.display = 'flex';
  }).catch(()=>{});

  btn.onclick = toggle;

  function toggle(){ open=!open; win.classList.toggle('ak-open',open); if(open) setTimeout(()=>inpEl.focus(),300); }

  inpEl.addEventListener('input',()=>{ sndBtn.disabled=!inpEl.value.trim()||typing; });
  inpEl.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();doSend();} });
  sndBtn.addEventListener('click', doSend);

  function doSend(){
    const t=inpEl.value.trim(); if(!t||typing) return;
    inpEl.value=''; sndBtn.disabled=true; sendText(t);
  }

  async function sendText(text){
    addMsg('user',text); typing=true;
    const tid=showTyping();
    try{
      const r=await fetch(`${BASE}/api/chat/${AGENT_ID}`,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({messages:messages.slice(-12), sessionId, source:'widget'})
      });
      const d=await r.json();
      document.getElementById(tid)?.remove();
      if(d.reply) addMsg('assistant',d.reply);
    }catch{
      document.getElementById(tid)?.remove();
      addMsg('assistant','⚠️ Fehler – bitte erneut versuchen.');
    }
    typing=false; sndBtn.disabled=!inpEl.value.trim();
  }

  function addMsg(role,text){
    const div=document.createElement('div');
    div.className=`ak-msg ${role==='user'?'ak-u':'ak-a'}`;
    const av=role==='user'?'👤':(agent?.emoji||'🤖');
    const bgStyle=role==='user'?`style="background:${agent?.color||'#6c5ce7'}"`:'' ;
    div.innerHTML=`<div class="ak-mav">${av}</div><div class="ak-bbl" ${bgStyle}>${esc(text)}</div>`;
    msgsEl.appendChild(div);
    msgsEl.scrollTop=msgsEl.scrollHeight;
    messages.push({role:role==='user'?'user':'assistant',content:text});
  }

  function showTyping(){
    const id='ak-typ-'+Date.now();
    const div=document.createElement('div'); div.id=id;
    div.className='ak-msg ak-a';
    div.innerHTML=`<div class="ak-mav">${agent?.emoji||'🤖'}</div><div class="ak-typ"><span></span><span></span><span></span></div>`;
    msgsEl.appendChild(div); msgsEl.scrollTop=msgsEl.scrollHeight; return id;
  }

  function esc(t){ return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); }
})();
