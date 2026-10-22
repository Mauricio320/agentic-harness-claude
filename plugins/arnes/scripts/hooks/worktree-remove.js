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
// En un worktree nativo de Claude Code solo niega con commits sin subir o cambios sin commitear:
// Claude Code quita solo los enlaces al borrarlo. En el de una carpeta multi-repo, antes de dejarlo
// borrar quita lo que trajo adentro (worktree-carpeta.js): los enlaces, sin seguirlos, y el worktree
// de cada repo, con git worktree remove desde su repo; las ramas del issue quedan en los repos. Con un
// repo con cambios sin commitear no quita nada y niega, porque Claude Code no los ve: los repos están
// ignorados en el repo de carpeta. No hay hook WorktreeRemove: ese evento solo corre para worktrees
// que creó un hook WorktreeCreate, y los nativos los borra git.
// Vale haya o no manifiesto; sin manifiesto, la rama por defecto es la de origin/HEAD, o main o master.
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { git } = require('../lib/exec.js');
const { mergeTargets, unmerged, refExists } = require('../lib/branches.js');
const { linkedWorktree, targetOf, liveLinks, nativeWork } = require('../worktree-ledger.js');
const { nativeWorktree } = require('../lib/worktree-nativo.js');
const carpeta = require('../worktree-carpeta.js');
const { bringBack } = require('../lib/timeline.js');

// Un worktree nativo de Claude Code: Claude Code lo borra quitando solo los enlaces (desde la 2.1.205),
// así que el enlace de node_modules no es el riesgo; lo es el trabajo sin subir, que se perdería.
function judgeNative(dir) {
  const project = loadProject(dir);
  const hit = project && !project.errors.length ? resolveWorkspace(project, dir) : null;
  const top = git(dir, ['rev-parse', '--show-toplevel']).stdout.trim();
  const own = nativeWork(dir, hit && hit.ws.defaultBranch).find((n) => path.resolve(n.path).toLowerCase() === path.resolve(top).toLowerCase());
  if (!own) return null;
  const what = [own.unpushed && `${own.unpushed} commit(s) sin subir`, own.dirty && `${own.dirty} archivo(s) sin commitear`].filter(Boolean).join(' y ');
  return `este worktree (rama ${own.branch}) tiene ${what}; borrarlo los pierde. Sube la rama con /arnes:ship, o commitea y sube a mano; después se puede borrar. Si no, sal con action "keep". Un worktree de Claude Code no se integra con un merge local.`;
}

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

// El worktree de una carpeta: lo de su repo de carpeta como cualquier nativo, y después lo que trajo.
function judgeFolder(dir) {
  const own = judgeNative(dir);
  if (own) return own;
  const r = carpeta.dematerialize(dir);
  if (!r.refused.length) return null;
  return `no borro este worktree: ${r.refused.join('; ')}, y se perderían. Commitéalos con /arnes:ship --solo-commit, o sal con action "keep".`;
}

// Un worktree nativo que se va a borrar devuelve su timeline al checkout principal.
function keepTimeline(dir, why) {
  const w = nativeWorktree(dir);
  if (!why && w) bringBack(w.path, w.main);
  return why;
}

function judge(dir) {
  if (!linkedWorktree(dir)) return null;
  if (carpeta.folderWorktree(dir)) return keepTimeline(dir, judgeFolder(dir));
  if (nativeWorktree(dir)) return keepTimeline(dir, judgeNative(dir));
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
