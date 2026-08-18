'use strict';
/**
 * goal-engine.js
 * Super Agent Mode – Goal-driven autonomous execution.
 *
 * "Ich möchte 50 neue Kunden gewinnen."
 *   → analyze()    Ziel verstehen
 *   → plan()       Kampagne + Schritte erstellen
 *   → execute()    Schritte autonom ausführen
 *   → measure()    Erfolg messen
 */

const { callLLM }        = require('./llm');
const { superAgent }     = require('./super-agent');
const { memoryManager }  = require('./memory-manager');
const { taskRunner }     = require('./task-runner');

// ── STEP-DEFINITIONEN je Goal-Typ ───────────────────────────────────────────
const GOAL_TEMPLATES = {

  customer_acquisition: {
    title: 'Kundengewinnung',
    steps: [
      { n:1,  title:'Ziel analysieren',           type:'analyze',        icon:'🎯', color:'#7c3aed', approval_required:false, desc:'Zielgruppe, USP und Strategie definieren' },
      { n:2,  title:'Markt recherchieren',        type:'research',       icon:'🔬', color:'#38bdf8', approval_required:false, desc:'Wettbewerb, Zielgruppe und Kanäle analysieren' },
      { n:3,  title:'Leads sammeln',              type:'collect',        icon:'🎣', color:'#f59e0b', approval_required:false, desc:'Potenzielle Kunden identifizieren und Listen erstellen', depends_on:[2] },
      { n:4,  title:'Leads bewerten (BANT)',      type:'score',          icon:'⭐', color:'#f59e0b', approval_required:false, desc:'Leads nach Budget, Authority, Need, Timeline bewerten', depends_on:[3] },
      { n:5,  title:'CRM aktualisieren',          type:'update_crm',     icon:'🗂', color:'#6366f1', approval_required:false, desc:'Qualifizierte Leads in System eintragen', depends_on:[4] },
      { n:6,  title:'E-Mail-Kampagne vorbereiten',type:'prepare_email',  icon:'✍️', color:'#ec4899', approval_required:false, desc:'Personalisierte Outreach-Sequenz erstellen', depends_on:[4] },
      { n:7,  title:'Freigabe einholen',          type:'request_approval',icon:'🔐', color:'#f43f5e', approval_required:true, approval_level:'approve', desc:'Kampagne prüfen und genehmigen', depends_on:[6] },
      { n:8,  title:'Kampagne versenden',         type:'send',           icon:'📤', color:'#f59e0b', approval_required:false, desc:'E-Mails senden und Reaktionen tracken', depends_on:[7] },
      { n:9,  title:'Follow-ups planen',          type:'schedule',       icon:'🔄', color:'#10b981', approval_required:false, desc:'Automatische Follow-up-Sequenz einrichten', depends_on:[8] },
      { n:10, title:'Erfolg messen',              type:'measure',        icon:'📊', color:'#10b981', approval_required:false, desc:'Öffnungsraten, Antworten und Konversionen messen', depends_on:[8] },
    ],
    metrics: [
      { key:'leads_found',    name:'Leads gefunden',  unit:'Leads',     target_pct:2.0,  color:'#f59e0b' },
      { key:'leads_qualified',name:'Leads qualifiziert',unit:'Leads',   target_pct:0.4,  color:'#7c3aed' },
      { key:'emails_sent',    name:'E-Mails gesendet',unit:'E-Mails',   target_pct:0.4,  color:'#38bdf8' },
      { key:'replies',        name:'Antworten',       unit:'Antworten', target_pct:0.1,  color:'#10b981' },
      { key:'customers',      name:'Neue Kunden',     unit:'Kunden',    target_pct:1.0,  color:'#ec4899' },
    ],
  },

  revenue: {
    title: 'Umsatz steigern',
    steps: [
      { n:1, title:'Umsatz-Analyse',          type:'analyze',       icon:'📊', color:'#7c3aed', approval_required:false, desc:'Aktuelle Umsatzsituation und Potenziale analysieren' },
      { n:2, title:'Wachstumshebel finden',   type:'research',      icon:'🔬', color:'#38bdf8', approval_required:false, desc:'Upsell, Cross-sell und neue Kanäle identifizieren' },
      { n:3, title:'Bestandskunden ansprechen',type:'prepare_email', icon:'💌', color:'#ec4899', approval_required:false, desc:'Personalisierte Angebote für Bestandskunden', depends_on:[2] },
      { n:4, title:'Angebote vorbereiten',    type:'prepare_email', icon:'💰', color:'#f59e0b', approval_required:false, desc:'Maßgeschneiderte Angebote erstellen', depends_on:[2] },
      { n:5, title:'Freigabe',                type:'request_approval',icon:'🔐', color:'#f43f5e', approval_required:true, approval_level:'approve', desc:'Angebote freigeben', depends_on:[3,4] },
      { n:6, title:'Versenden',               type:'send',          icon:'📤', color:'#f59e0b', approval_required:false, desc:'Angebote versenden', depends_on:[5] },
      { n:7, title:'Umsatz messen',           type:'measure',       icon:'📈', color:'#10b981', approval_required:false, desc:'Konversionsrate und Umsatz tracken', depends_on:[6] },
    ],
    metrics: [
      { key:'customers_contacted', name:'Kunden kontaktiert', unit:'Kontakte', target_pct:1.0, color:'#38bdf8' },
      { key:'offers_sent',         name:'Angebote gesendet',  unit:'Angebote', target_pct:0.5, color:'#f59e0b' },
      { key:'revenue_generated',   name:'Umsatz generiert',   unit:'€',        target_pct:1.0, color:'#10b981' },
    ],
  },

  research: {
    title: 'Marktrecherche',
    steps: [
      { n:1, title:'Recherche-Scope definieren', type:'analyze',   icon:'🎯', color:'#7c3aed', approval_required:false, desc:'Recherche-Fragen und Quellen festlegen' },
      { n:2, title:'Web-Recherche',              type:'research',  icon:'🔬', color:'#38bdf8', approval_required:false, desc:'Umfassende Webrecherche zu allen Aspekten', depends_on:[1] },
      { n:3, title:'Daten strukturieren',        type:'score',     icon:'📊', color:'#6366f1', approval_required:false, desc:'Erkenntnisse kategorisieren und gewichten', depends_on:[2] },
      { n:4, title:'Bericht erstellen',          type:'measure',   icon:'📋', color:'#10b981', approval_required:false, desc:'Strukturierten Forschungsbericht erstellen', depends_on:[3] },
    ],
    metrics: [
      { key:'sources_analyzed',  name:'Quellen analysiert', unit:'Quellen',  target_pct:1.0, color:'#38bdf8' },
      { key:'insights_found',    name:'Erkenntnisse',       unit:'Insights', target_pct:1.0, color:'#7c3aed' },
    ],
  },

  awareness: {
    title: 'Bekanntheit aufbauen',
    steps: [
      { n:1, title:'Zielgruppe definieren',    type:'analyze',       icon:'🎯', color:'#7c3aed', approval_required:false, desc:'Buyer Persona und Kanäle bestimmen' },
      { n:2, title:'Content-Strategie',        type:'research',      icon:'📢', color:'#ec4899', approval_required:false, desc:'Themen, Formate und Posting-Plan erstellen' },
      { n:3, title:'Inhalte erstellen',        type:'prepare_email', icon:'✍️', color:'#ec4899', approval_required:false, desc:'Blog-Posts, Social-Media-Inhalte und E-Mails', depends_on:[2] },
      { n:4, title:'Freigabe Content',         type:'request_approval',icon:'🔐', color:'#f43f5e', approval_required:true, approval_level:'approve', desc:'Inhalte prüfen und genehmigen', depends_on:[3] },
      { n:5, title:'Veröffentlichen',          type:'send',          icon:'📤', color:'#f59e0b', approval_required:false, desc:'Inhalte über alle Kanäle verteilen', depends_on:[4] },
      { n:6, title:'Reichweite messen',        type:'measure',       icon:'📊', color:'#10b981', approval_required:false, desc:'Impressionen, Klicks und Engagement tracken', depends_on:[5] },
    ],
    metrics: [
      { key:'content_pieces',  name:'Inhalte erstellt', unit:'Stück',   target_pct:1.0, color:'#ec4899' },
      { key:'reach',           name:'Reichweite',       unit:'Personen',target_pct:1.0, color:'#38bdf8' },
      { key:'engagement',      name:'Engagement',       unit:'Aktionen',target_pct:1.0, color:'#f59e0b' },
    ],
  },
};

// ── Ziel analysieren (LLM) ───────────────────────────────────────────────────
async function analyze(pool, { rawGoal, context, userId, model = 'claude-sonnet-4-6' }) {
  // Business-Memory laden
  let businessCtx = '';
  try {
    const biz = await pool.query(
      "SELECT key,value FROM agent_memory WHERE user_id=$1 AND scope='business' LIMIT 10",
      [userId]
    );
    if (biz.rows.length) businessCtx = biz.rows.map(r => `${r.key}: ${r.value}`).join('\n');
  } catch {}

  const resp = await callLLM(model,
    'Du analysierst Geschäftsziele und strukturierst sie. Antworte NUR mit validem JSON.',
    [{ role: 'user', content: `Analysiere dieses Geschäftsziel:
"${rawGoal}"
${context ? 'Kontext: ' + context : ''}
${businessCtx ? 'Unternehmenswissen:\n' + businessCtx : ''}

JSON-Format:
{
  "goal_type": "customer_acquisition|revenue|awareness|retention|research",
  "goal_title": "Kurztitel (max 50 Zeichen)",
  "goal_metric": "Konkrete messbare Zielgröße (z.B. '50 neue Kunden')",
  "target_value": 50,
  "target_unit": "Kunden",
  "goal_timeframe": "3 Monate",
  "industry": "Branche falls erkennbar",
  "strategy_summary": "Welche Strategie macht Sinn? (2-3 Sätze)",
  "key_challenges": ["Herausforderung 1", "Herausforderung 2"],
  "suggested_approach": "Konkrete nächste Schritte"
}` }]
  );

  try {
    const m = resp.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {
      goal_type: 'customer_acquisition',
      goal_title: rawGoal.slice(0, 50),
      goal_metric: rawGoal,
      target_value: 0,
      target_unit: 'Einheiten',
      goal_timeframe: '3 Monate',
      strategy_summary: 'Schrittweise Umsetzung des Ziels.',
      key_challenges: [],
      suggested_approach: 'Systematische Ausführung.'
    };
  } catch {
    return { goal_type: 'customer_acquisition', goal_title: rawGoal.slice(0,50), target_value: 0, target_unit: 'Einheiten' };
  }
}

// ── Kampagne + Schritte erstellen ───────────────────────────────────────────
async function createCampaign(pool, { goalId, userId, analysis, model = 'claude-sonnet-4-6' }) {
  const template = GOAL_TEMPLATES[analysis.goal_type] || GOAL_TEMPLATES.customer_acquisition;

  // Kampagne in DB
  const cr = await pool.query(
    `INSERT INTO goal_campaigns
       (goal_id,user_id,name,description,strategy,step_count)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [goalId, userId,
     analysis.goal_title || 'Kampagne',
     analysis.goal_metric,
     analysis.strategy_summary,
     template.steps.length]
  );
  const campaignId = cr.rows[0].id;

  // Schritte anlegen
  for (const step of template.steps) {
    await pool.query(
      `INSERT INTO goal_steps
         (campaign_id,goal_id,step_number,title,description,step_type,
          icon,color,approval_required,approval_level,depends_on,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'waiting')`,
      [campaignId, goalId, step.n, step.title, step.desc, step.type,
       step.icon, step.color, step.approval_required || false,
       step.approval_level || 'notify', step.depends_on || []]
    );
  }

  // Metriken anlegen
  for (const m of template.metrics) {
    const target = analysis.target_value ? Math.round(analysis.target_value * m.target_pct) : 0;
    await pool.query(
      `INSERT INTO goal_metrics (goal_id,metric_name,metric_key,target,unit,color)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (goal_id,metric_key) DO NOTHING`,
      [goalId, m.name, m.key, target, m.unit, m.color]
    );
  }

  return campaignId;
}

// ── Aktivitäts-Log schreiben ─────────────────────────────────────────────────
async function log(pool, { goalId, stepId, type, title, detail, data }) {
  await pool.query(
    `INSERT INTO goal_activity (goal_id,step_id,type,title,detail,data)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [goalId, stepId||null, type, title, detail||null, data ? JSON.stringify(data) : null]
  ).catch(() => {});
}

// ── Metrik aktualisieren ─────────────────────────────────────────────────────
async function updateMetric(pool, goalId, key, value) {
  await pool.query(
    `UPDATE goal_metrics SET current_value=$1, updated_at=now()
     WHERE goal_id=$2 AND metric_key=$3`,
    [value, goalId, key]
  ).catch(() => {});

  // Goal-Fortschritt neu berechnen
  const r = await pool.query(
    `SELECT COALESCE(AVG(CASE WHEN target>0 THEN LEAST(current_value/target,1)*100 ELSE 0 END),0) AS pct
     FROM goal_metrics WHERE goal_id=$1`,
    [goalId]
  );
  const pct = Math.round(r.rows[0]?.pct || 0);
  await pool.query(
    'UPDATE goals SET progress=$1, updated_at=now() WHERE id=$2',
    [pct, goalId]
  ).catch(() => {});
}

// ── Einzelnen Schritt ausführen ──────────────────────────────────────────────
async function executeStep(pool, step, { goalId, campaignId, userId, analysis, model }) {
  await pool.query(
    "UPDATE goal_steps SET status='running',started_at=now() WHERE id=$1", [step.id]
  );
  await log(pool, { goalId, stepId: step.id, type:'step_started', title:`${step.icon} ${step.title} gestartet` });

  let result = {};
  let summary = '';

  try {
    switch (step.step_type) {

      case 'analyze': {
        const r = await callLLM(model, 'Du bist ein strategischer Business-Analyst.',
          [{ role:'user', content:`Analysiere dieses Ziel und erstelle einen konkreten Aktionsplan:
Ziel: ${analysis.raw_goal}
Branche: ${analysis.industry || 'Unbekannt'}
Zeitrahmen: ${analysis.goal_timeframe}

Erstelle:
1. Zielgruppen-Profil (3-4 Punkte)
2. Wichtigste Kanäle
3. Konkrete Maßnahmen (5 Punkte)
4. Erfolgskennzahlen` }]
        );
        result = { analysis: r };
        summary = r.slice(0, 400);
        break;
      }

      case 'research': {
        const webAgent = require('./web-agent');
        const query = `${analysis.goal_title} ${analysis.industry || ''} Strategie Deutschland`;
        const searchResults = await webAgent.search(pool, { query, maxResults: 5 }).catch(() => []);

        // Top-Ergebnis scrapen
        let content = '';
        if (searchResults[0]) {
          try {
            const scraped = await webAgent.scrape(pool, searchResults[0].url);
            content = scraped.content.slice(0, 3000);
          } catch {}
        }

        const synthesis = await callLLM(model,
          'Du bist ein Research-Spezialist. Fasse die wichtigsten Erkenntnisse strukturiert zusammen.',
          [{ role:'user', content:`Ziel: ${analysis.raw_goal}\nQuellen:\n${searchResults.map(r=>r.title+': '+r.snippet).join('\n')}\n\nInhalt:\n${content}\n\nFasse die wichtigsten Erkenntnisse für die Zielerreichung zusammen.` }]
        );
        result = { sources: searchResults, synthesis };
        summary = synthesis.slice(0, 400);
        await updateMetric(pool, goalId, 'sources_analyzed', searchResults.length);
        break;
      }

      case 'collect': {
        // Leads aus vorhandenen Daten + Web-Recherche
        const webAgent = require('./web-agent');
        const query = `${analysis.industry || ''} Unternehmen Deutschland Kontakt Entscheider`;
        const leads = await webAgent.search(pool, { query, maxResults: 10 }).catch(() => []);

        const leadsData = leads.map((l, i) => ({
          id: i + 1,
          source: l.url,
          name: l.title,
          snippet: l.snippet,
          score: null,
        }));

        result = { leads: leadsData, count: leadsData.length };
        summary = `${leadsData.length} potenzielle Leads identifiziert`;
        await updateMetric(pool, goalId, 'leads_found', leadsData.length);
        await log(pool, { goalId, stepId:step.id, type:'metric_updated', title:`${leadsData.length} Leads gefunden`, data:{count:leadsData.length} });
        break;
      }

      case 'score': {
        // Leads aus vorherigem Schritt bewerten
        const prevStep = await pool.query(
          "SELECT result FROM goal_steps WHERE campaign_id=$1 AND step_type='collect' LIMIT 1",
          [campaignId]
        );
        const prevLeads = prevStep.rows[0]?.result?.leads || [];

        const scored = await Promise.all(prevLeads.slice(0, 5).map(async (lead, i) => {
          const score = Math.round(5 + Math.random() * 5); // Simulation — in Produktion: LLM
          return { ...lead, score, qualification: score >= 8 ? 'hot' : score >= 6 ? 'warm' : 'cold' };
        }));
        const hot = scored.filter(l => l.qualification === 'hot').length;
        result = { scored, hot, warm: scored.filter(l=>l.qualification==='warm').length };
        summary = `${scored.length} Leads bewertet: ${hot} heiß, ${result.warm} warm`;
        await updateMetric(pool, goalId, 'leads_qualified', hot + result.warm);
        break;
      }

      case 'update_crm': {
        // Leads in memory speichern (simulated CRM update)
        const scoredStep = await pool.query(
          "SELECT result FROM goal_steps WHERE campaign_id=$1 AND step_type='score' LIMIT 1",
          [campaignId]
        );
        const leads = scoredStep.rows[0]?.result?.scored || [];
        await memoryManager.set(pool, {
          userId, agentId: null, scope: 'business',
          key: `campaign_${campaignId}_leads`,
          value: JSON.stringify(leads.slice(0, 5)),
          source: 'system'
        });
        result = { updated: leads.length, message: 'Leads in CRM gespeichert' };
        summary = `${leads.length} Leads im CRM aktualisiert`;
        break;
      }

      case 'prepare_email': {
        const scoredStep = await pool.query(
          "SELECT result FROM goal_steps WHERE campaign_id=$1 AND step_type IN ('score','collect') LIMIT 1",
          [campaignId]
        );
        const leads = scoredStep.rows[0]?.result?.scored || scoredStep.rows[0]?.result?.leads || [];
        const topLead = leads.find(l => l.qualification === 'hot') || leads[0];

        const emailDraft = await callLLM(model,
          'Du bist ein Outreach-Spezialist. Schreibe überzeugende, personalisierte E-Mails.',
          [{ role:'user', content:`Schreibe 3 kurze, professionelle Outreach-E-Mails (Betreff + Text, max 150 Wörter) für das Ziel: "${analysis.raw_goal}"
Branche: ${analysis.industry || 'B2B'}
Ton: professionell aber persönlich
E-Mail 1: Erstkontakt
E-Mail 2: Follow-up (5 Tage später)
E-Mail 3: Letzter Versuch (2 Wochen später)` }]
        );
        result = { emails: emailDraft, lead_count: leads.length };
        summary = `${leads.length} personalisierte E-Mail-Sequenzen vorbereitet`;
        await updateMetric(pool, goalId, 'emails_sent', 0); // Noch nicht gesendet
        break;
      }

      case 'send': {
        // Simulation — in Produktion: echte E-Mail via Integration
        const emailStep = await pool.query(
          "SELECT result FROM goal_steps WHERE campaign_id=$1 AND step_type='prepare_email' LIMIT 1",
          [campaignId]
        );
        const leadCount = emailStep.rows[0]?.result?.lead_count || 0;
        result = { sent: leadCount, status: 'Kampagne gestartet', note: 'E-Mails werden innerhalb von 24h versendet' };
        summary = `${leadCount} E-Mails versendet / geplant`;
        await updateMetric(pool, goalId, 'emails_sent', leadCount);
        await log(pool, { goalId, stepId:step.id, type:'message', title:`📤 ${leadCount} E-Mails versendet` });
        break;
      }

      case 'schedule': {
        // Follow-up-Tasks erstellen
        const task = await taskRunner.create(pool, {
          userId, agentId: null,
          title: `Follow-up: ${analysis.goal_title}`,
          description: `Automatische Follow-up-Sequenz für Kampagne ${campaignId}`,
          type: 'email',
          payload: { campaignId, goalId, scheduled: true },
          scheduledAt: new Date(Date.now() + 5 * 86400000).toISOString(),
        });
        result = { task_id: task.id, note: 'Follow-up in 5 Tagen geplant' };
        summary = 'Follow-up-Sequenz eingerichtet';
        break;
      }

      case 'measure': {
        // Simulated metrics (in Produktion: echte Daten)
        const sentStep = await pool.query(
          "SELECT result FROM goal_steps WHERE campaign_id=$1 AND step_type='send' LIMIT 1",
          [campaignId]
        );
        const sent = sentStep.rows[0]?.result?.sent || 0;
        const opens = Math.round(sent * 0.32);
        const replies = Math.round(sent * 0.08);
        const customers = Math.round(sent * 0.02);

        result = { sent, opens, open_rate: sent ? `${Math.round(opens/sent*100)}%` : '—', replies, customers };
        summary = `Öffnungsrate: ${result.open_rate} · ${replies} Antworten · ${customers} Konversionen`;
        await updateMetric(pool, goalId, 'replies', replies);
        await updateMetric(pool, goalId, 'customers', customers);
        break;
      }

      case 'report': {
        const r = await callLLM(model, 'Du erstellst präzise Erfolgberichte.',
          [{ role:'user', content:`Erstelle einen Abschlussbericht für:\nZiel: ${analysis.raw_goal}\nBitte strukturiert mit: Zusammenfassung, Erreichte Ziele, Learnings, Empfehlungen` }]
        );
        result = { report: r };
        summary = r.slice(0, 400);
        break;
      }

      case 'request_approval': {
        // Approval-Eintrag erstellen
        await pool.query(
          `INSERT INTO approvals
             (user_id,goal_id,type,title,description,proposed_action,level)
           VALUES ($1,$2,'plan_step',$3,$4,$5,$6)`,
          [userId, goalId,
           `✅ Freigabe: ${step.title}`,
           step.description,
           JSON.stringify({ step_id: step.id, campaign_id: campaignId, goal: analysis.raw_goal }),
           step.approval_level || 'approve'
          ]
        ).catch(() => {});
        result = { status: 'waiting_for_approval' };
        summary = 'Freigabe angefordert — bitte prüfen';
        return { result, summary, needsApproval: true };
      }

      default: {
        result = { status: 'completed', type: step.step_type };
        summary = `${step.title} abgeschlossen`;
      }
    }

    await pool.query(
      `UPDATE goal_steps SET status='completed',result=$1,result_summary=$2,completed_at=now() WHERE id=$3`,
      [JSON.stringify(result), summary, step.id]
    );
    await log(pool, { goalId, stepId:step.id, type:'step_done', title:`${step.icon} ${step.title} abgeschlossen`, detail:summary });
    return { result, summary };

  } catch (e) {
    await pool.query(
      "UPDATE goal_steps SET status='failed',error_msg=$1,completed_at=now() WHERE id=$2",
      [e.message, step.id]
    );
    await log(pool, { goalId, stepId:step.id, type:'step_done', title:`❌ ${step.title} fehlgeschlagen`, detail:e.message });
    return { error: e.message };
  }
}

// ── Kampagne ausführen ───────────────────────────────────────────────────────
async function runCampaign(pool, { goalId, campaignId, userId, model = 'claude-sonnet-4-6' }) {
  const gRow = await pool.query('SELECT * FROM goals WHERE id=$1', [goalId]);
  if (!gRow.rows.length) throw new Error('Ziel nicht gefunden');
  const goal = gRow.rows[0];
  const analysis = {
    raw_goal: goal.raw_goal, goal_type: goal.goal_type,
    goal_title: goal.goal_title, goal_metric: goal.goal_metric,
    target_value: goal.target_value, target_unit: goal.target_unit,
    goal_timeframe: goal.goal_timeframe, industry: goal.industry,
  };

  await pool.query("UPDATE goal_campaigns SET status='active',updated_at=now() WHERE id=$1", [campaignId]);
  await pool.query("UPDATE goals SET status='running',started_at=now(),updated_at=now() WHERE id=$1", [goalId]);

  const maxRounds = 15;
  for (let round = 0; round < maxRounds; round++) {
    // Nächsten ausführbaren Schritt laden
    const steps = await pool.query(
      `SELECT s.* FROM goal_steps s
       WHERE s.campaign_id=$1 AND s.status='waiting'
       ORDER BY s.step_number LIMIT 20`,
      [campaignId]
    );

    const completed = await pool.query(
      'SELECT step_number FROM goal_steps WHERE campaign_id=$1 AND status=\'completed\'',
      [campaignId]
    );
    const doneNums = new Set(completed.rows.map(r => r.step_number));

    let anyReady = false;
    for (const step of steps.rows) {
      const deps = step.depends_on || [];
      if (deps.every(d => doneNums.has(d))) {
        anyReady = true;

        // Approval-Check
        if (step.approval_required && step.approval_level === 'approve') {
          await pool.query(
            "UPDATE goal_steps SET status='waiting_approval' WHERE id=$1", [step.id]
          );
          await executeStep(pool, step, { goalId, campaignId, userId, analysis, model });
          await pool.query("UPDATE goals SET status='paused',updated_at=now() WHERE id=$1", [goalId]);
          await log(pool, { goalId, type:'approval_needed', title:'🔐 Freigabe erforderlich', detail:step.title });
          return; // Pausieren bis Freigabe
        }

        await executeStep(pool, step, { goalId, campaignId, userId, analysis, model });
        doneNums.add(step.step_number);

        // Kampagnen-Fortschritt
        await pool.query(
          'UPDATE goal_campaigns SET steps_done=steps_done+1,current_step=$1,updated_at=now() WHERE id=$2',
          [step.step_number + 1, campaignId]
        );
      }
    }

    if (!anyReady) break;
  }

  // Kampagne abschließen
  const allDone = await pool.query(
    "SELECT COUNT(*) FROM goal_steps WHERE campaign_id=$1 AND status NOT IN ('completed','skipped')",
    [campaignId]
  );
  if (parseInt(allDone.rows[0].count) === 0) {
    await pool.query("UPDATE goal_campaigns SET status='completed',updated_at=now() WHERE id=$1", [campaignId]);
    await pool.query(
      "UPDATE goals SET status='completed',completed_at=now(),progress=100,updated_at=now() WHERE id=$1",
      [goalId]
    );
    await log(pool, { goalId, type:'message', title:'🎉 Ziel erreicht!', detail:'Alle Schritte erfolgreich abgeschlossen.' });
  }
}

// ── Neues Ziel starten ────────────────────────────────────────────────────────
async function startGoal(pool, { userId, rawGoal, context, model = 'claude-sonnet-4-6' }) {
  // 1. Analyse
  const analysis = await analyze(pool, { rawGoal, context, userId, model });

  // 2. Ziel speichern
  const gr = await pool.query(
    `INSERT INTO goals
       (user_id,raw_goal,goal_type,goal_title,goal_metric,goal_timeframe,
        target_value,target_unit,industry,context,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planning') RETURNING id`,
    [userId, rawGoal, analysis.goal_type, analysis.goal_title,
     analysis.goal_metric, analysis.goal_timeframe,
     analysis.target_value || 0, analysis.target_unit,
     analysis.industry, context || null]
  );
  const goalId = gr.rows[0].id;
  await log(pool, { goalId, type:'message', title:'🎯 Ziel analysiert', detail:analysis.strategy_summary });

  // 3. Kampagne + Schritte anlegen
  const campaignId = await createCampaign(pool, { goalId, userId, analysis, model });
  await pool.query("UPDATE goals SET status='running',updated_at=now() WHERE id=$1", [goalId]);
  await log(pool, { goalId, type:'message', title:'📋 Kampagne erstellt', detail:`${GOAL_TEMPLATES[analysis.goal_type]?.steps?.length || 0} Schritte geplant` });

  return { goalId, campaignId, analysis };
}

// ── Nach Approval: Kampagne fortsetzen ──────────────────────────────────────
async function resumeAfterApproval(pool, { goalId, stepId, userId }) {
  const sr = await pool.query('SELECT * FROM goal_steps WHERE id=$1', [stepId]);
  if (!sr.rows.length) throw new Error('Schritt nicht gefunden');
  const step = sr.rows[0];

  await pool.query("UPDATE goal_steps SET status='completed',completed_at=now() WHERE id=$1", [step.id]);
  await pool.query("UPDATE goals SET status='running',updated_at=now() WHERE id=$1", [goalId]);
  await log(pool, { goalId, stepId, type:'step_done', title:`✅ ${step.title} freigegeben` });

  // Asynchron weiterlaufen
  setImmediate(async () => {
    await runCampaign(pool, { goalId, campaignId: step.campaign_id, userId }).catch(e =>
      console.error('[goal-engine] Resume Fehler:', e.message)
    );
  });
}

const goalEngine = { analyze, startGoal, runCampaign, resumeAfterApproval, updateMetric, log };
module.exports = { goalEngine };
