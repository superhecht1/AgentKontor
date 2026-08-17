'use strict';
/**
 * planner.js
 * Zerlegt ein Nutzerziel in ausführbare Schritte,
 * führt sie sequenziell aus und synthetisiert das Ergebnis.
 *
 * Flow:
 *   decompose(goal) → plan_steps[]
 *   → forEach step:
 *       checkApproval(step) → auto | pause(waiting_approval)
 *       execute(step) → result
 *       summarize(result) → result_summary
 *   → synthesize(all_results) → final answer
 */

const { callLLM } = require('./llm');
const { executeTool, loadAgentTools } = require('./tool-executor');
const { memoryManager } = require('./memory-manager');

// ── Approval-Level einer Aktion bestimmen ───────────────────────────────────
async function resolveApprovalLevel(pool, { userId, agentId, toolName, actionType }) {
  // Regeln laden (höhere Priorität gewinnt)
  const r = await pool.query(
    `SELECT level FROM approval_rules
     WHERE user_id=$1
       AND (agent_id=$2 OR agent_id IS NULL)
       AND enabled=true
       AND (
         action_pattern = $3
         OR action_pattern = $4
         OR action_pattern = '*'
       )
     ORDER BY priority DESC, agent_id DESC NULLS LAST
     LIMIT 1`,
    [userId, agentId, toolName || '', actionType || '']
  );
  return r.rows[0]?.level || 'auto';
}

// ── Approval-Eintrag erstellen und auf Entscheidung warten ──────────────────
async function requestApproval(pool, {
  userId, agentId, planId, stepId,
  title, description, proposedAction, level,
}) {
  const r = await pool.query(
    `INSERT INTO approvals
       (user_id,agent_id,plan_id,step_id,type,title,description,proposed_action,level)
     VALUES ($1,$2,$3,$4,'plan_step',$5,$6,$7,$8)
     RETURNING id`,
    [userId, agentId, planId, stepId, title, description,
     JSON.stringify(proposedAction), level]
  );
  return r.rows[0].id;
}

// ── Auf Approval warten (polling, max. 10 Minuten) ──────────────────────────
async function waitForApproval(pool, approvalId, timeoutMs = 600_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await pool.query(
      'SELECT status, response_note FROM approvals WHERE id=$1',
      [approvalId]
    );
    const row = r.rows[0];
    if (!row) throw new Error('Approval nicht gefunden');
    if (row.status === 'approved') return { approved: true, note: row.response_note };
    if (row.status === 'rejected') return { approved: false, note: row.response_note };
    if (row.status === 'expired')  return { approved: false, note: 'Abgelaufen' };
    await new Promise(res => setTimeout(res, 3000)); // 3s polling
  }
  // Timeout → als abgelehnt behandeln
  await pool.query(
    "UPDATE approvals SET status='expired' WHERE id=$1 AND status='pending'",
    [approvalId]
  );
  return { approved: false, note: 'Timeout' };
}

// ── Ziel in Schritte zerlegen (LLM) ────────────────────────────────────────
async function decompose(pool, { goal, context, agentId, userId, model = 'claude-sonnet-4-6' }) {
  // Verfügbare Tools laden
  const tools = await loadAgentTools(pool, agentId);
  const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join('\n') ||
    '- get_current_time\n- calculate\n- save_to_memory\n- create_task\n- send_email';

  // Memory-Kontext laden
  let memCtx = '';
  try {
    memCtx = await memoryManager.buildMemoryContext(pool, { agentId, userId });
  } catch {}

  const systemPrompt = `Du bist ein Planungs-Assistent. Du zerlegst ein Nutzerziel in konkrete, ausführbare Schritte.

Verfügbare Tools:
${toolList}

Regeln:
- Maximal 7 Schritte
- Jeder Schritt nutzt EIN Tool ODER ist ein "think"-Schritt (LLM-Analyse ohne Tool)
- Approval-Level: "auto" (unbedenklich), "notify" (User informieren), "approve" (User muss bestätigen)
- Geldausgaben, externe Nachrichten, irreversible Aktionen → "approve"
- Recherche, Berechnung, Lesen → "auto"
- E-Mails, externe API-Schreibzugriffe → "notify" oder "approve"
${memCtx}

Antworte NUR mit validem JSON (kein Markdown, kein Kommentar):
{
  "goal_understood": "...",
  "steps": [
    {
      "step_number": 1,
      "title": "...",
      "description": "...",
      "reasoning": "Warum dieser Schritt?",
      "tool_name": "tool_name oder null",
      "tool_input": { ... },
      "approval_level": "auto|notify|approve",
      "depends_on": []
    }
  ],
  "expected_result": "Was wird am Ende geliefert?"
}`;

  const raw = await callLLM(model, systemPrompt,
    [{ role: 'user', content: `Ziel: ${goal}${context ? '\nKontext: ' + context : ''}` }]
  );

  // JSON extrahieren
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('LLM hat kein valides JSON zurückgegeben');
  return JSON.parse(jsonMatch[0]);
}

// ── Einzelnen Schritt ausführen ─────────────────────────────────────────────
async function executeStep(pool, step, { agentId, userId, planId, model, previousResults }) {
  // Step-Status auf running setzen
  await pool.query(
    "UPDATE plan_steps SET status='running', started_at=now() WHERE id=$1",
    [step.id]
  );

  let result = null;
  let resultSummary = '';

  try {
    if (step.tool_name) {
      // Tool-basierter Schritt
      const tools = await loadAgentTools(pool, agentId);
      const toolDef = tools.find(t => t.name === step.tool_name);

      // Auch Builtin-Tools direkt laden
      const { BUILTIN_DEFINITIONS, executeTool: exec } = require('./tool-executor');
      const builtinDef = BUILTIN_DEFINITIONS.find(t => t.name === step.tool_name);
      const def = toolDef || (builtinDef ? { ...builtinDef, id: null } : null);

      if (!def) throw new Error(`Tool nicht gefunden: ${step.tool_name}`);

      // Input anreichern mit Ergebnissen vorheriger Schritte
      const enrichedInput = enrichInput(step.tool_input || {}, previousResults);

      result = await exec(def, enrichedInput, { pool, agentId, userId });
      resultSummary = typeof result === 'object'
        ? JSON.stringify(result).slice(0, 300)
        : String(result).slice(0, 300);
    } else {
      // LLM-Analyse-Schritt (kein Tool)
      const prevContext = Object.entries(previousResults)
        .map(([n, r]) => `Schritt ${n}: ${JSON.stringify(r).slice(0, 200)}`)
        .join('\n');

      const resp = await callLLM(model,
        'Du bist ein hilfreicher Analyse-Assistent. Antworte präzise und strukturiert.',
        [{
          role: 'user',
          content: `Aufgabe: ${step.description}\n\nVorherige Ergebnisse:\n${prevContext || 'keine'}`
        }]
      );
      result = { analysis: resp };
      resultSummary = resp.slice(0, 400);
    }

    await pool.query(
      `UPDATE plan_steps SET
         status='completed', result=$1, result_summary=$2,
         completed_at=now()
       WHERE id=$3`,
      [JSON.stringify(result), resultSummary, step.id]
    );
    return { success: true, result };
  } catch (e) {
    await pool.query(
      "UPDATE plan_steps SET status='failed', error=$1, completed_at=now() WHERE id=$2",
      [e.message, step.id]
    );
    return { success: false, error: e.message };
  }
}

// ── Vorherige Ergebnisse in Tool-Input einfügen ─────────────────────────────
function enrichInput(input, previousResults) {
  const str = JSON.stringify(input);
  // {{step_1_result}}, {{step_2_result}} etc. ersetzen
  const enriched = str.replace(/\{\{step_(\d+)_result\}\}/g, (_, n) => {
    const r = previousResults[n];
    return r ? JSON.stringify(r) : '';
  });
  try { return JSON.parse(enriched); } catch { return input; }
}

// ── Finalergebnis synthetisieren ────────────────────────────────────────────
async function synthesize(pool, { planId, goal, steps, model }) {
  const stepsContext = steps
    .filter(s => s.status === 'completed')
    .map(s => `**${s.title}**\n${s.result_summary || JSON.stringify(s.result).slice(0,200)}`)
    .join('\n\n');

  const systemPrompt = 'Du bist ein Assistent der Aufgabenergebnisse zu einer klaren Antwort zusammenfasst.';
  const userMsg = `Ursprüngliches Ziel: ${goal}\n\nAusgeführte Schritte und Ergebnisse:\n\n${stepsContext}\n\nFasse die Ergebnisse in einer klaren, präzisen Antwort zusammen.`;

  const result = await callLLM(model, systemPrompt, [{ role: 'user', content: userMsg }]);

  await pool.query(
    "UPDATE agent_plans SET result=$1, status='completed', completed_at=now(), updated_at=now() WHERE id=$2",
    [result, planId]
  );
  return result;
}

// ── Haupt-Plan-Ausführung ────────────────────────────────────────────────────
async function runPlan(pool, planId) {
  const planRow = await pool.query('SELECT * FROM agent_plans WHERE id=$1', [planId]);
  if (!planRow.rows.length) throw new Error('Plan nicht gefunden');
  const plan = planRow.rows[0];

  if (plan.status === 'cancelled' || plan.status === 'completed') return;

  await pool.query(
    "UPDATE agent_plans SET status='running', updated_at=now() WHERE id=$1",
    [planId]
  );

  const stepsR = await pool.query(
    'SELECT * FROM plan_steps WHERE plan_id=$1 ORDER BY step_number',
    [planId]
  );
  const steps = stepsR.rows;
  const previousResults = {};

  for (const step of steps) {
    if (step.status === 'completed' || step.status === 'skipped') {
      if (step.result) previousResults[step.step_number] = step.result;
      continue;
    }
    if (step.status === 'rejected') continue;

    // Abhängigkeiten prüfen
    if (step.depends_on?.length) {
      const deps = steps.filter(s => step.depends_on.includes(s.step_number));
      const allDone = deps.every(d => d.status === 'completed');
      if (!allDone) {
        await pool.query(
          "UPDATE plan_steps SET status='skipped' WHERE id=$1", [step.id]
        );
        continue;
      }
    }

    // Approval prüfen
    if (step.approval_level !== 'auto') {
      // Status auf waiting_approval setzen
      await pool.query(
        "UPDATE plan_steps SET status='waiting_approval' WHERE id=$1", [step.id]
      );
      await pool.query(
        "UPDATE agent_plans SET status='paused', updated_at=now() WHERE id=$1", [planId]
      );

      const approvalId = await requestApproval(pool, {
        userId: plan.user_id,
        agentId: plan.agent_id,
        planId: plan.id,
        stepId: step.id,
        title: step.title,
        description: step.description,
        proposedAction: { tool: step.tool_name, input: step.tool_input },
        level: step.approval_level,
      });

      if (step.approval_level === 'approve') {
        // Warten bis User entscheidet
        const decision = await waitForApproval(pool, approvalId);
        if (!decision.approved) {
          await pool.query(
            "UPDATE plan_steps SET status='rejected', error=$1 WHERE id=$2",
            ['Vom Nutzer abgelehnt: ' + (decision.note || ''), step.id]
          );
          // Plan als failed markieren wenn kritischer Schritt abgelehnt
          await pool.query(
            "UPDATE agent_plans SET status='failed', error_msg='Schritt abgelehnt: '+$1, updated_at=now() WHERE id=$2",
            [step.title, planId]
          );
          return;
        }
        await pool.query(
          "UPDATE plan_steps SET status='approved' WHERE id=$1", [step.id]
        );
        await pool.query(
          "UPDATE agent_plans SET status='running', updated_at=now() WHERE id=$1", [planId]
        );
      }
      // notify → einfach weitermachen
    }

    // Schritt ausführen
    const exec = await executeStep(pool, step, {
      agentId: plan.agent_id,
      userId: plan.user_id,
      planId: plan.id,
      model: plan.model || 'claude-sonnet-4-6',
      previousResults,
    });

    if (exec.success) {
      previousResults[step.step_number] = exec.result;
    } else if (step.approval_level === 'approve') {
      // Kritischer Fehler → Plan stoppen
      await pool.query(
        "UPDATE agent_plans SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2",
        [exec.error, planId]
      );
      return;
    }

    // Fortschritt aktualisieren
    await pool.query(
      'UPDATE agent_plans SET steps_done=steps_done+1, updated_at=now() WHERE id=$1',
      [planId]
    );
  }

  // Finales Ergebnis synthetisieren
  const updatedSteps = await pool.query(
    'SELECT * FROM plan_steps WHERE plan_id=$1 ORDER BY step_number', [planId]
  );
  await synthesize(pool, {
    planId,
    goal: plan.goal,
    steps: updatedSteps.rows,
    model: plan.model || 'claude-sonnet-4-6',
  });
}

// ── Plan erstellen + sofort starten ─────────────────────────────────────────
async function createAndRun(pool, { userId, agentId, goal, context, model = 'claude-sonnet-4-6', sessionId }) {
  // 1. Zerlegen
  const decomposed = await decompose(pool, { goal, context, agentId, userId, model });

  // 2. Plan in DB speichern
  const planR = await pool.query(
    `INSERT INTO agent_plans
       (user_id,agent_id,session_id,goal,context,model,step_count,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'planning') RETURNING *`,
    [userId, agentId, sessionId||null, goal, context||null, model,
     decomposed.steps.length]
  );
  const plan = planR.rows[0];

  // 3. Schritte speichern
  for (const step of decomposed.steps) {
    await pool.query(
      `INSERT INTO plan_steps
         (plan_id,step_number,title,description,reasoning,tool_name,
          tool_input,approval_level,depends_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [plan.id, step.step_number, step.title, step.description,
       step.reasoning, step.tool_name||null,
       JSON.stringify(step.tool_input||{}),
       step.approval_level||'auto',
       step.depends_on||[]]
    );
  }

  // 4. Asynchron ausführen (nicht blockieren)
  setImmediate(() => {
    runPlan(pool, plan.id).catch(e =>
      console.error(`[planner] Plan ${plan.id} Fehler:`, e.message)
    );
  });

  return { plan, decomposed };
}

const planner = { decompose, createAndRun, runPlan, executeStep, synthesize, resolveApprovalLevel };
module.exports = { planner };
