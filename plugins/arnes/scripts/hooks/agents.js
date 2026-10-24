#!/usr/bin/env node
// SubagentStart y SubagentStop (docs/PLAN.md §6.2): el registro de los agentes del arnés que están
// corriendo, para que el Stop no bloquee mientras un dev o un test-writer trabaja en segundo plano.
// Un archivo por agente, .tmp/harness/agents/<agent_id>.json = { type, at }: dos agentes que arrancan
// a la vez no se pisan. SubagentStart lo escribe y SubagentStop lo borra. Solo cuentan los tipos
// arnes:*; uno de más de dos horas se da por muerto (un agente que no llegó a su Stop no puede dejar
// el Stop sin bloquear para siempre). Sin manifiesto no hace nada.
// Un agente lanzado con isolation: worktree arranca en su propio worktree (el cwd de la entrada es
// <principal>/.claude/worktrees/agent-<id>): SubagentStart lo anota en el registro del checkout que lo
// lanzó y le enlaza node_modules (worktree-ledger.js record), y el registro de agentes vivos va al
// proyecto de ese checkout, que es donde mira su Stop.
// Salida: nada. Siempre exit 0.

'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('../lib/hook.js');
const { loadProject, harnessDir } = require('../lib/manifest.js');
const { agentWorktree } = require('../lib/worktree-nativo.js');
const ledger = require('../worktree-ledger.js');

const MAX_AGE_MS = 2 * 60 * 60 * 1000;

const dirOf = (project) => path.join(harnessDir(project), 'agents');
const fileOf = (project, id) => path.join(dirOf(project), `${String(id).replace(/[^\w.-]/g, '_')}.json`);

// Los agentes del arnés vivos: [{ id, type, at }].
function running(project, now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(dirOf(project)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dirOf(project), f), 'utf8'));
      if (now - Date.parse(a.at) < MAX_AGE_MS) out.push({ id: f.slice(0, -5), type: a.type, at: a.at });
    } catch {
      /* ilegible: no cuenta */
    }
  }
  return out;
}

function agents(input) {
  const type = String(input.agent_type || '');
  if (!input.agent_id || !type.startsWith('arnes:')) return null;
  const cwd = path.resolve(input.cwd || process.cwd());
  const isolated = Boolean(agentWorktree(cwd));
  const owner = isolated ? (input.hook_event_name === 'SubagentStart' ? ledger.record(input) : ledger.ownerOf(agentWorktree(cwd).path)) : null;
  const project = isolated ? owner : loadProject(cwd);
  if (!project || project.errors.length) return null;
  const file = fileOf(project, input.agent_id);
  if (input.hook_event_name === 'SubagentStart') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ type, at: new Date().toISOString() }) + '\n');
  } else if (input.hook_event_name === 'SubagentStop') {
    fs.rmSync(file, { force: true });
  }
  return null;
}

module.exports = { agents, running };

if (require.main === module) run('agents', agents);
