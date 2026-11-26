'use strict';
// Commits de una rama que no están integrados en sus ramas destino. Lo usan el guard (branch -D,
// git worktree remove) y worktree-remove.js (ExitWorktree). Este módulo no elige el destino: si
// la rama o la carpeta están abiertas en worktree-ledger.js, worktree-remove.js (targetsOf) y el
// guard miden contra la rama del issue registrada ahí; si no, contra la rama por defecto de
// mergeTargets. Además, dónde está el manifiesto que un repo no tiene (manifestElsewhere), para
// init-draft y adoption-check: la línea de --check (missingManifest), que con una rama remota que lo
// trae dice que init va a adoptar desde cero en la rama actual, y la de init (adoptionElsewhere), que
// nombra esa rama sin cambiarse a ella: entre varias remotas, la que lo agregó primero, con quién y
// cuándo.

const { spawnSync } = require('child_process');
const { git, lines } = require('./exec.js');

function refExists(dir, ref) {
  return git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

// Refs contra las que se mide la integración: la rama por defecto local y la de origin, las que
// existan. Sin manifiesto o sin defaultBranch, la de origin/HEAD, o main o master.
function mergeTargets(dir, defaultBranch) {
  let branch = defaultBranch;
  if (!branch) {
    const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (head.status === 0) branch = head.stdout.trim().replace(/^origin\//, '');
  }
  if (!branch) branch = ['main', 'master'].find((b) => refExists(dir, b) || refExists(dir, `origin/${b}`));
  const candidates = branch ? [branch, `origin/${branch}`] : ['main', 'origin/main', 'master', 'origin/master'];
  return { branch: branch || 'main', refs: candidates.filter((r) => refExists(dir, r)) };
}

// La rama a la que llega el trabajo de un workspace: integration.targetBranch con la entrega push
// (docs/PLAN.md §7), o su defaultBranch. null sin ninguna de las dos: quien llama cae en mergeTargets.
function targetBranch(project, ws) {
  const i = (project && project.integration) || {};
  return (i.merge === 'push' && i.targetBranch) || (ws && ws.defaultBranch) || null;
}

// Hashes cortos de los commits de `ref` que no están en ninguna de las `targets`, o null si
// `ref` no existe.
function unmerged(dir, ref, targets) {
  if (!refExists(dir, ref)) return null;
  const r = git(dir, ['rev-list', '--abbrev-commit', ref, '--not', ...targets, '--']);
  return r.status === 0 ? lines(r.stdout) : null;
}

// Un repo sin .claude/harness.json: en qué rama está y qué ramas remotas sí lo traen. Se sabe sin
// checkout, con un solo git cat-file --batch-check sobre <rama remota>:.claude/harness.json; las
// remotas son las que trajo el último git fetch. → { branch, remotes: [..] }
function manifestElsewhere(dir) {
  const head = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = head.status === 0 ? head.stdout.trim() : '';
  const branch = !name ? 'sin rama' : name === 'HEAD' ? `HEAD suelto en ${git(dir, ['rev-parse', '--short', 'HEAD']).stdout.trim()}` : name;
  const refs = lines(git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']).stdout).filter((r) => !/\/HEAD$/.test(r));
  if (!refs.length) return { branch, remotes: [] };
  const r = spawnSync('git', ['cat-file', '--batch-check'], { cwd: dir, input: `${refs.map((x) => `${x}:.claude/harness.json`).join('\n')}\n`, encoding: 'utf8' });
  const out = lines(r.stdout || '');
  return { branch, remotes: refs.filter((_, i) => / blob \d+$/.test(out[i] || '')) };
}

function missingManifest(name, where) {
  const n = where.remotes.length;
  const hint = n ? `; ${where.remotes.slice(0, 3).join(', ')}${n > 3 ? ` y ${n - 3} más` : ''} ${n > 1 ? 'lo traen' : 'lo trae'}, y /arnes:init va a adoptar desde cero aquí, en ${where.branch}` : '';
  return `${name} en ${where.branch}, sin .claude/harness.json${hint}`;
}

function adoptionElsewhere(dir, name, where) {
  const added = where.remotes.map((ref) => {
    const log = lines(git(dir, ['log', '--diff-filter=A', '--format=%ct%x09%an%x09%cs', ref, '--', '.claude/harness.json']).stdout);
    const [ct, author, date] = (log[log.length - 1] || '').split('\t');
    return { ref, ct: Number(ct) || Infinity, author, date };
  });
  const pick = added.sort((a, b) => a.ct - b.ct)[0];
  const who = pick.author ? ` (la escribió ${pick.author}${pick.date ? ` el ${pick.date}` : ''})` : '';
  return `${name} está en ${where.branch}, sin la configuración del arnés; ${pick.ref} sí la trae${who}. No me cambio a esa rama: adopto desde cero aquí, en ${where.branch}, porque la adopción tiene que salir de main.`;
}

module.exports = { refExists, mergeTargets, targetBranch, unmerged, manifestElsewhere, missingManifest, adoptionElsewhere };
