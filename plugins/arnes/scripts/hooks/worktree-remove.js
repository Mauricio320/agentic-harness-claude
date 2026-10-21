#!/usr/bin/env node
// PreToolUse sobre ExitWorktree (docs/PLAN.md §6.2, §7). Deniega `action: "remove"` cuando la rama
// del worktree en que está la sesión (el cwd del JSON de entrada) tiene commits que no están en su
// destino: ExitWorktree solo exige discard_changes, que el modelo puede pasar, y esos commits se
// perderían. El destino es la rama del issue registrada en .tmp/harness/worktrees.json si el
// worktree está abierto en el registro; si no, la rama por defecto del workspace. `git worktree
// remove` por Bash o PowerShell lo cubre guard.js con la misma regla. No es un hook WorktreeRemove:
// ese evento solo existe para worktrees creados por un hook WorktreeCreate propio, y el arnés usa
// los de git.
//
// Vale haya o no manifiesto; sin manifiesto, la rama por defecto es la de origin/HEAD, o main o master.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { git } = require('../lib/exec.js');
const { mergeTargets, unmerged, refExists } = require('../lib/branches.js');
const { linkedWorktree, targetOf, liveLinks } = require('../worktree-ledger.js');

// Destino de integración del worktree en dir: el registrado en el ledger, o la rama por defecto.
function targetsOf(dir, branch) {
  const top = git(dir, ['rev-parse', '--show-toplevel']).stdout.trim();
  const registered = targetOf(dir, { branch, wtPath: top || dir });
  const refs = registered ? [registered, `origin/${registered}`].filter((r) => refExists(dir, r)) : [];
  if (refs.length) return { branch: registered, refs };
  const project = loadProject(dir);
  const hit = project && !project.errors.length ? resolveWorkspace(project, dir) : null;
  return mergeTargets(dir, hit && hit.ws.defaultBranch);
}

function judge(dir) {
  if (!linkedWorktree(dir)) return null;
  const links = liveLinks(git(dir, ['rev-parse', '--show-toplevel']).stdout.trim() || dir);
  if (links.length) return `este worktree tiene enlaces del arnés (${links.join(', ')}) que borrarlo seguiría. Ciérralo con /arnes:worktree integrate o close, que los quita primero, o sal con action "keep".`;
  const name = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const { branch, refs } = targetsOf(dir, name);
  if (!refs.length) return null;
  const commits = unmerged(dir, 'HEAD', refs);
  if (!commits || !commits.length) return null;
  return (
    `este worktree (rama ${name}) tiene ${commits.length} commit(s) que no están en ${branch} ` +
    `(${commits.slice(0, 3).join(', ')}); borrarlo los pierde. Intégralos con git merge --no-ff ${name} ` +
    `en ${branch}, o sal con action "keep".`
  );
}

module.exports = { judge, targetsOf };

if (require.main === module) {
  run('worktree-remove', (input) => {
    const ti = input.tool_input || {};
    if (ti.action !== 'remove') return null;
    const why = judge(path.resolve(input.cwd || process.cwd()));
    return why ? deny(`arnes: ${why}`) : null;
  });
}
