#!/usr/bin/env node
// PreToolUse sobre ExitWorktree (docs/PLAN.md §6.2). Deniega `action: "remove"` cuando la rama del
// worktree en que está la sesión (el cwd del JSON de entrada) tiene commits que no están en la
// rama por defecto del workspace: ExitWorktree solo exige discard_changes, que el modelo puede
// pasar, y esos commits se perderían. `git worktree remove` por Bash o PowerShell lo cubre
// guard.js con la misma regla. No es un hook WorktreeRemove: ese evento solo existe para
// worktrees creados por un hook WorktreeCreate propio, y el arnés usa los de git.
// Cuando exista el ledger (fase 3), el destino pasa a ser la rama registrada en él.
//
// Vale haya o no manifiesto; sin manifiesto, la rama por defecto es la de origin/HEAD, o main o master.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { git } = require('../lib/exec.js');
const { mergeTargets, unmerged } = require('../lib/branches.js');

function isLinkedWorktree(dir) {
  const own = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return own.status === 0 && common.status === 0 && path.resolve(own.stdout.trim()) !== path.resolve(common.stdout.trim());
}

function judge(dir) {
  if (!isLinkedWorktree(dir)) return null;
  const project = loadProject(dir);
  const hit = project && !project.errors.length ? resolveWorkspace(project, dir) : null;
  const { branch, refs } = mergeTargets(dir, hit && hit.ws.defaultBranch);
  if (!refs.length) return null;
  const commits = unmerged(dir, 'HEAD', refs);
  if (!commits || !commits.length) return null;
  const name = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  return (
    `este worktree (rama ${name}) tiene ${commits.length} commit(s) que no están en ${branch} ` +
    `(${commits.slice(0, 3).join(', ')}); borrarlo los pierde. Intégralos con git merge --no-ff ${name} ` +
    `en la rama destino, o sal con action "keep".`
  );
}

module.exports = { judge };

if (require.main === module) {
  run('worktree-remove', (input) => {
    const ti = input.tool_input || {};
    if (ti.action !== 'remove') return null;
    const why = judge(path.resolve(input.cwd || process.cwd()));
    return why ? deny(`arnes: ${why}`) : null;
  });
}
