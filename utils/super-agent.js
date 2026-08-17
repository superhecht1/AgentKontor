'use strict';
/**
 * super-agent.js
 * Orchestriert mehrere Spezialisten-Agenten.
 *
 * Flow:
 *   route(goal)  → LLM wählt Agenten + erstellt Plan
 *   run(plan)    → Agenten sequenziell / parallel ausführen
 *   synthesize() → Ergebnisse zu Antwort zusammenfassen
 */

const { callLLM }        = require('./llm');
const { executeTool, loadAgentTools, BUILTIN_DEFINITIONS } = require('./tool-executor');
const { memoryManager }  = require('./memory-manager');

// ── Spezialisten-Agenten-Definitionen (wird aus DB geladen + gecacht) ───────
let _profileCache = null;
let _profileCacheTime = 0;

async function loadProfiles(pool) {
  if (_profileCache && Date.now() - _profileCacheTime < 300000) return _profileCache;
  try {
    const r = await pool.query('SELECT * FROM specialist_profiles WHERE enabled=true ORDER BY slug');
    _profileCache = r.rows;
    _profileCacheTime = Date.now();
    return r.rows;
  } catch {
    return FALLBACK_PROFILES;
  }
}

// Fallback falls DB noch keine Tabelle hat
const FALLBACK_PROFILES = [
  { slug:'research', name:'Research Agent', emoji:'🔬', color:'#38bdf8',
    system_prompt:'Du bist ein Research-Spezialist. Recherchiere gründlich und präzise.',
    tools:['web_search','web_scrape','web_research','analyze_document'] },
  { slug:'sales',    name:'Sales Agent',    emoji:'💼', color:'#f59e0b',
    system_prompt:'Du bist ein Sales-Spezialist. Qualifiziere Leads und erstelle Outreach.',
    tools:['qualify_leads','calendar_find_slots','save_to_memory','create_task'] },
  { slug:'support',  name:'Support Agent',  emoji:'🎧', color:'#10b981',
    system_prompt:'Du bist ein Support-Spezialist. Beantworte Anfragen effizient.',
    tools:['read_from_memory','save_to_memory','email_get_messages','create_task'] },
  { slug:'data',     name:'Data Agent',     emoji:'📊', color:'#6366f1',
    system_prompt:'Du bist ein Daten-Analyst. Analysiere Daten präzise.',
    tools:['calculate','analyze_document','web_research'] },
  { slug:'marketing',name:'Marketing Agent',emoji:'📢', color:'#ec4899',
    system_prompt:'Du bist ein Marketing-Spezialist. Erstelle Inhalte und Kampagnen.',
    tools:['web_search','web_research','save_to_memory','create_task'] },
  { slug:'finance',  name:'Finance Agent',  emoji:'💰', color:'#f43f5e',
    system_prompt:'Du bist ein Finanz-Analyst. Analysiere Finanzdaten genau.',
    tools:['calculate','analyze_document','web_search'] },
];

// ── Routing: welche Agenten braucht dieses Ziel? ────────────────────────────
async function route(pool, { goal, context, model = 'claude-sonnet-4-6', userId }) {
  const profiles = await loadProfiles(pool);
  const profileList = profiles.map(p =>
    `- ${p.slug} (${p.name} ${p.emoji}): ${p.description}`
  ).join('\n');

  // Memory-Kontext einbeziehen
  let memCtx = '';
  if (userId) {
    try {
      const biz = await pool.query(
        "SELECT key,value FROM agent_memory WHERE user_id=$1 AND scope='business' LIMIT 10",
        [userId]
      );
      if (biz.rows.length) {
        memCtx = '\n\nUnternehmenswissen:\n' + biz.rows.map(r => `${r.key}: ${r.value}`).join('\n');
      }
    } catch {}
  }

  const resp = await callLLM(model,
    `Du bist ein Super-Agent-Router. Entscheide welche Spezialisten-Agenten für eine Aufgabe benötigt werden.
Antworte IMMER nur mit validem JSON, ohne Kommentare oder Markdown.${memCtx}`,
    [{ role: 'user', content: `Aufgabe: ${goal}${context ? '\nKontext: ' + context : ''}

Verfügbare Agenten:
${profileList}

Erstelle einen Ausführungsplan. JSON-Format:
{
  "analysis": "Kurze Analyse der Aufgabe",
  "agents_needed": ["research", "sales"],
  "parallel": true,
  "steps": [
    {
      "step": 1,
      "agent": "research",
      "task": "Konkrete Aufgabe für diesen Agenten",
      "tools": ["web_search", "web_scrape"],
      "depends_on": [],
      "expected_output": "Was soll dieser Agent liefern?"
    }
  ],
  "synthesis_strategy": "Wie sollen die Ergebnisse kombiniert werden?"
}

Regeln:
- Nur Agenten einsetzen die wirklich benötigt werden (max 4)
- Unabhängige Schritte parallel=true setzen
- depends_on enthält step-Nummern
- tasks konkret und ausführbar formulieren` }]
  );

  try {
    const m = resp.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return {
      analysis: 'Konnte nicht analysiert werden',
      agents_needed: ['research'],
      parallel: false,
      steps: [{ step:1, agent:'research', task: goal, tools:['web_search'], depends_on:[], expected_output:'Informationen zum Thema' }],
      synthesis_strategy: 'Direkte Weitergabe'
    };
  }
}

// ── Einzelnen Spezialisten-Agenten ausführen ─────────────────────────────────
async function runSpecialist(pool, profile, { task, tools, expectedOutput, previousResults = {}, sessionId, userId, model }) {
  // System-Prompt aufbauen
  let systemPrompt = profile.system_prompt;

  // Ergebnisse vorheriger Agenten einbeziehen
  const prevCtx = Object.entries(previousResults)
    .map(([slug, r]) => `${slug}: ${typeof r === 'string' ? r.slice(0,500) : JSON.stringify(r).slice(0,500)}`)
    .join('\n\n');
  if (prevCtx) {
    systemPrompt += `\n\n## Ergebnisse anderer Agenten:\n${prevCtx}`;
  }

  // Memory laden
  try {
    const memCtx = await memoryManager.buildMemoryContext(pool, { agentId: null, userId });
    if (memCtx) systemPrompt += memCtx;
  } catch {}

  // Tool-Aufrufe durch LLM veranlassen (ReAct-Muster)
  const messages = [{ role: 'user', content: `Aufgabe: ${task}\n\nErwartetes Ergebnis: ${expectedOutput}` }];
  const allowedTools = (tools || profile.tools || []);

  // Tool-Definitionen für LLM formatieren
  const toolDefs = BUILTIN_DEFINITIONS.filter(t => allowedTools.includes(t.name));
  const toolDesc = toolDefs.map(t => `- ${t.name}: ${t.description}`).join('\n');

  if (toolDesc) {
    systemPrompt += `\n\n## Verfügbare Tools:\n${toolDesc}\n\nWenn du ein Tool nutzen willst, schreibe:\nTOOL: tool_name\nINPUT: {"param": "value"}\n\nWarte dann auf das Ergebnis bevor du weiter machst.`;
  }

  // Erste LLM-Antwort
  let response = await callLLM(model || 'claude-sonnet-4-6', systemPrompt, messages);

  // Tool-Aufrufe verarbeiten (max 5 Runden)
  const toolResults = [];
  for (let round = 0; round < 5; round++) {
    const toolMatch = response.match(/TOOL:\s*(\w+)\s*\nINPUT:\s*(\{[\s\S]*?\})/);
    if (!toolMatch) break;

    const [, toolName, inputStr] = toolMatch;
    let toolInput = {};
    try { toolInput = JSON.parse(inputStr); } catch {}

    // Tool ausführen
    const toolDef = BUILTIN_DEFINITIONS.find(t => t.name === toolName);
    if (toolDef) {
      let toolResult;
      try {
        toolResult = await executeTool(toolDef, toolInput, { pool, userId, sessionId });
        const resultStr = JSON.stringify(toolResult).slice(0, 2000);
        toolResults.push({ tool: toolName, input: toolInput, result: toolResult });

        // Nächste Runde mit Tool-Ergebnis
        messages.push({ role: 'assistant', content: response });
        messages.push({ role: 'user', content: `Tool-Ergebnis (${toolName}):\n${resultStr}\n\nMache mit deiner Analyse weiter.` });
        response = await callLLM(model || 'claude-sonnet-4-6', systemPrompt, messages);
      } catch (e) {
        messages.push({ role: 'assistant', content: response });
        messages.push({ role: 'user', content: `Tool-Fehler (${toolName}): ${e.message}\n\nMache ohne dieses Tool weiter.` });
        response = await callLLM(model || 'claude-sonnet-4-6', systemPrompt, messages);
      }
    } else break;
  }

  // Agent-Nachricht speichern
  if (pool && sessionId) {
    pool.query(
      `INSERT INTO agent_messages (session_id,from_agent,to_agent,message_type,content,data)
       VALUES ($1,$2,'super','result',$3,$4)`,
      [sessionId, profile.slug, response.slice(0, 5000), JSON.stringify({ toolResults })]
    ).catch(() => {});
  }

  return { result: response, toolResults, agent: profile.slug };
}

// ── Alle Agenten-Ergebnisse synthetisieren ───────────────────────────────────
async function synthesize(pool, { goal, agentResults, routingResult, model, sessionId }) {
  const resultsText = Object.entries(agentResults)
    .map(([slug, r]) => {
      const res = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return `### ${r.emoji || '🤖'} ${r.name || slug}\n${res.slice(0, 3000)}`;
    }).join('\n\n---\n\n');

  const systemPrompt = `Du bist ein Super-Agent, der die Ergebnisse mehrerer Spezialisten zu einer kohärenten, umfassenden Antwort zusammenfasst.
Strategie: ${routingResult?.synthesis_strategy || 'Alle Ergebnisse integrieren'}`;

  const response = await callLLM(model || 'claude-sonnet-4-6', systemPrompt, [{
    role: 'user',
    content: `Ursprüngliche Aufgabe: ${goal}\n\nErgebnisse der Spezialisten:\n${resultsText}\n\nFasse alle Ergebnisse zu einer klaren, strukturierten Gesamtantwort zusammen. Nutze Überschriften und Struktur.`
  }]);

  if (pool && sessionId) {
    pool.query(
      `INSERT INTO agent_messages (session_id,from_agent,to_agent,message_type,content)
       VALUES ($1,'super','user','result',$2)`,
      [sessionId, response.slice(0, 10000)]
    ).catch(() => {});
  }

  return response;
}

// ── Haupt-Orchestrierung ─────────────────────────────────────────────────────
async function orchestrate(pool, sessionId) {
  const start = Date.now();

  // Session laden
  const sr = await pool.query('SELECT * FROM super_agent_sessions WHERE id=$1', [sessionId]);
  if (!sr.rows.length) throw new Error('Session nicht gefunden');
  const session = sr.rows[0];

  const updateSession = (fields) => pool.query(
    `UPDATE super_agent_sessions SET ${Object.keys(fields).map((k,i) => `${k}=$${i+2}`).join(',')}, updated_at=now() WHERE id=$1`,
    [sessionId, ...Object.values(fields)]
  );

  try {
    const profiles = await loadProfiles(pool);

    // 1. Routing
    await updateSession({ status: 'routing' });
    const routingResult = await route(pool, {
      goal: session.goal,
      context: session.context,
      model: session.model,
      userId: session.user_id,
    });
    await updateSession({ status: 'planning', routing_result: JSON.stringify(routingResult) });

    const plan = routingResult?.steps || [];
    await updateSession({ plan: JSON.stringify(plan) });

    // Routing-Nachricht
    await pool.query(
      `INSERT INTO agent_messages (session_id,from_agent,to_agent,message_type,content,data)
       VALUES ($1,'super','system','status_update',$2,$3)`,
      [sessionId,
       `Agenten ausgewählt: ${routingResult.agents_needed?.join(', ')}`,
       JSON.stringify(routingResult)]
    );

    // 2. Ausführung
    await updateSession({ status: 'running' });
    const agentResults = {};
    const completedSteps = new Set();

    // Schritte nach Abhängigkeiten sortiert ausführen
    const maxRounds = plan.length + 2;
    for (let round = 0; round < maxRounds && completedSteps.size < plan.length; round++) {
      const readySteps = plan.filter(step => {
        if (completedSteps.has(step.step)) return false;
        const deps = step.depends_on || [];
        return deps.every(d => completedSteps.has(d));
      });

      if (!readySteps.length) break;

      // Parallele Ausführung wenn möglich
      const runStep = async (step) => {
        const profile = profiles.find(p => p.slug === step.agent) ||
                        FALLBACK_PROFILES.find(p => p.slug === step.agent) ||
                        { slug: step.agent, name: step.agent, emoji: '🤖', system_prompt: 'Du bist ein hilfreicher Agent.', tools: [] };

        // Start-Nachricht
        await pool.query(
          `INSERT INTO agent_messages (session_id,from_agent,to_agent,message_type,content)
           VALUES ($1,'super',$2,'task',$3)`,
          [sessionId, step.agent, step.task]
        );

        const r = await runSpecialist(pool, profile, {
          task: step.task,
          tools: step.tools || profile.tools,
          expectedOutput: step.expected_output,
          previousResults: Object.fromEntries(
            Object.entries(agentResults).map(([k,v]) => [k, v.result])
          ),
          sessionId,
          userId: session.user_id,
          model: session.model,
        });

        agentResults[step.agent] = { ...r, emoji: profile.emoji, name: profile.name, color: profile.color };
        completedSteps.add(step.step);

        // Ergebnisse persistieren
        await updateSession({ agent_results: JSON.stringify(agentResults) });
      };

      if (routingResult.parallel && readySteps.length > 1) {
        await Promise.all(readySteps.map(runStep));
      } else {
        for (const step of readySteps) await runStep(step);
      }
    }

    // 3. Synthese
    await updateSession({ status: 'synthesizing' });
    const finalResult = await synthesize(pool, {
      goal: session.goal,
      agentResults,
      routingResult,
      model: session.model,
      sessionId,
    });

    // Abschließen
    await updateSession({
      status: 'completed',
      final_result: finalResult,
      total_duration_ms: Date.now() - start,
    });
    await pool.query('UPDATE super_agent_sessions SET completed_at=now() WHERE id=$1', [sessionId]);

    // Kollaboration protokollieren
    const slugs = Object.keys(agentResults);
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i+1; j < slugs.length; j++) {
        pool.query(
          `INSERT INTO agent_collaborations (agent_a,agent_b,count,last_session)
           VALUES ($1,$2,1,now())
           ON CONFLICT (agent_a,agent_b) DO UPDATE SET count=agent_collaborations.count+1, last_session=now()`,
          [slugs[i], slugs[j]]
        ).catch(() => {});
      }
    }

    return { result: finalResult, agentResults, routingResult, duration: Date.now() - start };

  } catch (e) {
    await updateSession({ status: 'failed', error_msg: e.message });
    throw e;
  }
}

const superAgent = { route, runSpecialist, synthesize, orchestrate, loadProfiles };
module.exports = { superAgent };
