'use strict';
// El rescate del trabajo sin commitear de los repos traídos al worktree de una carpeta (docs/PLAN.md
// §7). Esos repos viven dentro del worktree de carpeta, porque Claude Code solo deja escribir ahí a una
// sesión aislada en él; y Claude Code borra ese worktree sin pasar por el arnés (al cerrar una sesión
// y elegir borrar, o desde el escritorio), sin ver sus cambios, porque los repos están ignorados en el
// repo de carpeta. Por eso, después de cada turno (Stop) y al arrancar (SessionStart), el estado sin
// commitear de cada repo se guarda como un commit fuera de toda rama, en refs/arnes/rescate/<nombre>
// de su propio repo: un worktree comparte los objetos y las refs con su checkout principal, así que el
// ref sobrevive al borrado. Se arma con un índice aparte, sin tocar el del worktree, y lleva los
// archivos sin trackear que el repo no ignora. Con el repo limpio, el ref se borra. El mensaje del
// commit dice de dónde salió: el worktree, la rama, el issue y los archivos.
// Mientras algún repo tenga trabajo sin commitear o sin subir, la raíz del worktree de carpeta lleva
// MARKER, un archivo sin trackear ni ignorar: Claude Code lo cuenta como trabajo y, al salir, pregunta
// si conservar o borrar en vez de borrar solo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { git, lines, firstLine } = require('./exec.js');

const PREFIX = 'refs/arnes/rescate/';
const MARKER = '.arnes-trabajo-pendiente';
const WORKTREES = path.join('.claude', 'worktrees');

const posix = (p) => p.split(path.sep).join('/');
const AUTHOR = { GIT_AUTHOR_NAME: 'arnes', GIT_AUTHOR_EMAIL: 'arnes@localhost', GIT_COMMITTER_NAME: 'arnes', GIT_COMMITTER_EMAIL: 'arnes@localhost' };

// El estado sin commitear de wt como un árbol de git, armado en un índice aparte. exclude: rutas que
// puso el arnés (enlaces, copias de .env), que no se guardan; las que el repo ya ignora no se nombran,
// porque git add se niega a una ruta ignorada aunque sea para excluirla. → el hash del árbol, o null
function treeOf(wt, exclude = []) {
  const tmp = path.join(os.tmpdir(), `arnes-rescate-${process.pid}-${Date.now()}.idx`);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  const rel = [...exclude.map((p) => posix(path.relative(wt, p))).filter((r) => r && !r.startsWith('..')), '.tmp/harness'];
  const ignored = new Set(lines(git(wt, ['check-ignore', '--', ...rel]).stdout).map((l) => l.replace(/\/$/, '')));
  const skip = rel.filter((r) => !ignored.has(r));
  try {
    if (git(wt, ['read-tree', 'HEAD'], env).status !== 0) return null;
    if (git(wt, ['add', '-A', '--', '.', ...skip.map((r) => `:(exclude)${r}`)], env).status !== 0) return null;
    const t = git(wt, ['write-tree'], env);
    return t.status === 0 ? t.stdout.trim() : null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Guarda, actualiza o borra el rescate de wt en su repo. meta: { name, branch, issue }.
// → { ref, files, saved } (files vacío: no quedaba nada sin commitear y el ref se borró), o { error }
function save(wt, meta, exclude = []) {
  const ref = PREFIX + meta.name;
  const head = git(wt, ['rev-parse', 'HEAD']).stdout.trim();
  const tree = head ? treeOf(wt, exclude) : null;
  if (!tree) return { ref, files: [], error: 'git no pudo leer el worktree' };
  const files = lines(git(wt, ['diff', '--name-only', '--no-renames', head, tree]).stdout);
  if (!files.length) {
    git(wt, ['update-ref', '-d', ref]);
    return { ref, files };
  }
  const prev = git(wt, ['log', '-1', '--format=%T %P', ref]).stdout.trim();
  if (prev === `${tree} ${head}`) return { ref, files };
  const msg = [`arnes: rescate de ${meta.name}`, '', `worktree: ${posix(wt)}`, `rama: ${meta.branch}`, `issue: ${meta.issue || meta.name}`, `archivos: ${files.length}`, ...files.slice(0, 50).map((f) => `- ${f}`)].join('\n');
  const c = git(wt, ['commit-tree', tree, '-p', head, '-m', msg], { ...process.env, ...AUTHOR });
  if (c.status !== 0) return { ref, files, error: firstLine(c.stderr) };
  const u = git(wt, ['update-ref', '-m', 'arnes: rescate', ref, c.stdout.trim()]);
  return u.status === 0 ? { ref, files, saved: true } : { ref, files, error: firstLine(u.stderr) };
}

// Los rescates del repo: [{ name, ref, at, worktree, branch, issue, files }]
function list(repo) {
  const refs = lines(git(repo, ['for-each-ref', '--format=%(refname)', PREFIX]).stdout);
  return refs.map((ref) => {
    const [at, ...body] = git(repo, ['log', '-1', '--format=%cI%n%B', ref]).stdout.split(/\r?\n/);
    const field = (k) => ((body.find((l) => l.startsWith(`${k}: `)) || '').slice(k.length + 2) || null);
    return { name: ref.slice(PREFIX.length), ref, at: new Date(at), worktree: field('worktree'), branch: field('rama'), issue: field('issue'), files: body.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)), count: Number(field('archivos')) || 0 };
  });
}

// Los rescates del repo cuyo worktree ya no existe: el trabajo que quedó sin su carpeta.
const orphans = (repo) => list(repo).filter((x) => !x.worktree || !fs.existsSync(x.worktree));

const discard = (repo, name) => git(repo, ['update-ref', '-d', PREFIX + name]);

// Que el repo no vea sus worktrees como archivos sin trackear, sin tocar su .gitignore versionado.
function excludeWorktrees(repo) {
  if (git(repo, ['check-ignore', '-q', `${posix(WORKTREES)}/x`]).status === 0) return;
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  if (!common) return;
  const file = path.join(common, 'info', 'exclude');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}/${posix(WORKTREES)}/\n`);
}

const manualOf = (x) => `a mano: git worktree add <carpeta> ${x.ref}^ y, adentro, git restore --source=${x.ref} --worktree -- :/`;

// Aplica el rescate x en el worktree dst, que tiene que estar en el commit del que salió, y comprobado
// que quedó igual, borra el ref. exclude: lo que puso el arnés en dst. → { ok, line }
function apply(dst, x, exclude = []) {
  const name = path.basename(x.repo);
  if (git(dst, ['rev-parse', 'HEAD']).stdout.trim() !== git(dst, ['rev-parse', `${x.ref}^`]).stdout.trim()) {
    return { ok: false, line: `${name}: su rama avanzó después del rescate; no lo aplico solo, y dejo el ref ${x.ref} (${manualOf(x)})` };
  }
  const rs = git(dst, ['restore', `--source=${x.ref}`, '--worktree', '--', ':/']);
  const want = git(dst, ['rev-parse', `${x.ref}^{tree}`]).stdout.trim();
  if (rs.status !== 0 || treeOf(dst, exclude) !== want) return { ok: false, line: `${name}: los cambios no quedaron iguales al rescate; dejo el ref ${x.ref} (${firstLine(rs.stderr) || 'difieren'})` };
  discard(x.repo, x.name);
  return { ok: true, line: `${name}: recuperé sus ${x.count} archivo(s) sin commitear` };
}

// Recupera un rescate en un worktree nuevo del repo, <repo>/.claude/worktrees/<nombre>, en su rama y
// con los cambios sin commitear como estaban; comprobado eso, borra el ref. Si la rama avanzó después
// del rescate, o está abierta en otro lado, no lo toca y dice cómo hacerlo a mano. Es el camino de un
// rescate suelto; el de un worktree de carpeta lo recupera con la carpeta worktree-carpeta.js
// recoverFolder. → { ok, line }
function recover(repo, x) {
  const name = path.basename(repo);
  git(repo, ['worktree', 'prune']);
  const dst = path.join(repo, WORKTREES, x.name);
  const rel = posix(path.relative(path.dirname(repo), dst));
  if (fs.existsSync(dst)) return { ok: false, line: `${name}: ya hay algo en ${rel}; no recupero el rescate ahí` };
  const parent = git(repo, ['rev-parse', `${x.ref}^`]).stdout.trim();
  const branch = x.branch || `rescate-${x.name}`;
  const manual = manualOf(x);
  let args;
  if (git(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).status === 0) {
    const open = lines(git(repo, ['worktree', 'list', '--porcelain']).stdout).some((l) => l === `branch refs/heads/${branch}`);
    if (open) return { ok: false, line: `${name}: la rama ${branch} está abierta en otro worktree; no recupero el rescate solo (${manual})` };
    if (git(repo, ['rev-parse', branch]).stdout.trim() !== parent) return { ok: false, line: `${name}: la rama ${branch} avanzó después del rescate; no lo recupero solo (${manual})` };
    args = ['worktree', 'add', '-q', dst, branch];
  } else args = ['worktree', 'add', '-q', '-b', branch, dst, parent];
  excludeWorktrees(repo);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const add = git(repo, args);
  if (add.status !== 0) return { ok: false, line: `${name}: no pude crear el worktree (${firstLine(add.stderr)})` };
  const rs = git(dst, ['restore', `--source=${x.ref}`, '--worktree', '--', ':/']);
  const want = git(repo, ['rev-parse', `${x.ref}^{tree}`]).stdout.trim();
  if (rs.status !== 0 || treeOf(dst) !== want) return { ok: false, line: `${name}: creé ${rel}, pero los cambios no quedaron iguales al rescate; dejo el ref ${x.ref} (${firstLine(rs.stderr) || 'difieren'})` };
  discard(repo, x.name);
  const n = lines(git(dst, ['status', '--porcelain']).stdout).length;
  return { ok: true, line: `${name}: recuperé ${n} archivo(s) sin commitear en ${rel}, en la rama ${branch}; se sigue abriendo Claude Code en ${name} con --worktree ${x.name}` };
}

// El marcador del worktree de carpeta: lo escribe con lo pendiente, o lo quita si no queda nada.
// → true si quedó escrito
function mark(wt, issue, pending) {
  const file = path.join(wt, MARKER);
  if (!pending.length) {
    fs.rmSync(file, { force: true });
    return false;
  }
  const text = [
    `Trabajo sin commitear o sin subir en los repos de este worktree (issue ${issue}).`,
    'Lo mantiene el arnés: mientras exista, Claude Code pregunta antes de borrar este worktree. Se va solo cuando todo está commiteado y subido.',
    '',
    ...pending.map((p) => `- ${p}`),
    '',
  ].join('\n');
  let before = null;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    /* no estaba */
  }
  if (before !== text) fs.writeFileSync(file, text);
  return true;
}

module.exports = { PREFIX, MARKER, treeOf, save, list, orphans, discard, apply, recover, excludeWorktrees, mark };
