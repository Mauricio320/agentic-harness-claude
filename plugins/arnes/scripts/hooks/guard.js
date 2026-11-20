#!/usr/bin/env node
// PreToolUse sobre Bash y PowerShell (docs/PLAN.md §6.2). Parte el comando en segmentos con
// lib/shell.js, con las comillas y los escapes del shell de la herramienta (bash para Bash,
// PowerShell para PowerShell; el de un bash -c o un powershell -Command anidado, el suyo), y juzga
// cada uno por el ejecutable con que empieza: nunca mira el cuerpo de un heredoc. El directorio de
// cada segmento sigue los cd anteriores y el -C de git, a partir del cwd del JSON de entrada (nunca
// CLAUDE_PROJECT_DIR).
//
// Deniega siempre, haya o no manifiesto:
//   git reset --hard · git push forzado (--force, -f, --force-with-lease, refspec +) ·
//   git push que borra ramas del remoto (--delete, -d, refspec :rama, --prune, --mirror) ·
//   git restore, git checkout de rutas y git checkout o switch forzados, si botan cambios sin
//   commitear de archivos trackeados · git stash drop o clear con algo en la pila ·
//   fuera de init o setup en curso, en un proyecto del arnés: cualquier comando que escriba, borre o
//   mueva su configuración (lib/configuracion.js; por el shell solo se lee), o la carpeta que la
//   tiene, y el git commit que la lleva (también sin el manifiesto en el árbol) ·
//   git clean -f · git branch -D de una rama con commits fuera de su destino ·
//   git worktree remove de un worktree cuya rama tiene commits fuera de su destino ·
//   cualquier comando cuyos argumentos nombren la ruta de un archivo de secretos (los de
//   read-guard.js: .env y variantes salvo .env.example, ~/.ssh, ~/.aws, credenciales, llaves,
//   tokens; con manifiesto, además secretPaths), también dentro de un argumento, como el código de
//   un node -e o el --env-file=.env de una opción. No depende de una lista de lectores: tail, more,
//   sed, grep o Select-String caen igual que cat. Solo pasan ls, dir y rm (y Get-ChildItem y
//   Remove-Item, que son lo mismo en PowerShell), que no muestran el contenido, salvo que su salida
//   vaya a otro comando por una tubería o el argumento lleve una sustitución ($(...), <(...) o un
//   backtick). El destino de una redirección de salida (> .env) no cuenta: escribir no lo muestra.
//   La negativa trae el .env enmascarado, como la de read-guard.js (lib/env-mask.js)
// El destino de una rama es el registrado en .tmp/harness/worktrees.json si es de un worktree
// abierto del registro; si no, la rama por defecto del workspace.
// Deniega solo con manifiesto:
//   los comandos de `forbidden` del workspace (o de todos, si no se sabe cuál), salvo uno de su
//   afterBuild con la condición onlyIfLocalDb cumplida (lib/database.js localDb); los que tocan una
//   base (lib/database.js) con su propio motivo: los corre la persona desde su terminal ·
//   git commit sin bandera vigente (gate-flag.js) para ese workspace, o sin workspace claro ·
//   git add masivo (., -A, --all, :/, *) con .env o *.log sin trackear en su alcance
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { pieces, command, nestedCommand, tokenize } = require('../lib/shell.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { git, lines } = require('../lib/exec.js');
const { mergeTargets, unmerged, refExists } = require('../lib/branches.js');
const { checkFlag } = require('../gate-flag.js');
const { targetOf, liveLinks } = require('../worktree-ledger.js');
const { targetsOf } = require('./worktree-remove.js');
const { secretPath, maskedFile, deniedText } = require('./read-guard.js');
const { touchesDatabase, localDb } = require('../lib/database.js');
const { nativeWorktree } = require('../lib/worktree-nativo.js');
const { CONFIG_SPEC, configRoot, configHome, prepAt, AJUSTE, AJUSTE_JS } = require('../lib/configuracion.js');

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const LISTERS = new Set(['ls', 'dir', 'rm', 'get-childitem', 'gci', 'remove-item', 'test', '[', 'stat', 'test-path', 'get-item', 'gi']);
// Lo que solo da forma a una lista de nombres, y solo si va sin bloques ni expresiones (PLAIN): con un
// bloque o un paréntesis puede abrir el archivo que recibe. Select-String y Where-Object no van: el primero
// busca dentro de los archivos que le llegan por la tubería, y el segundo es un bloque de código.
const NAMERS = new Set(['select-object', 'select', 'format-table', 'ft', 'format-list', 'fl', 'sort-object', 'sort', 'measure-object', 'measure', 'out-string', 'head', 'tail', 'wc', 'grep', 'findstr', 'uniq', 'cut', 'tr']);
const PLAIN = /^[^{}()@$`]*$/;
// Un formateador que toma de su entrada la lista de archivos a abrir (sort --files0-from=-, findstr /f:/).
const FROM_INPUT = /files0-from|\/[fg]:/i;
// Los que no abren ningún archivo: lo que nombran es texto.
const TEXT_ONLY = new Set(['echo', 'printf', 'write-output', 'write-host']);
// Opciones cuyo valor es texto libre, no una ruta: el mensaje de un commit, el título y el cuerpo de un MR.
// Solo en los subcomandos de git que llevan mensaje y en gh y glab: en otros comandos -m o -t son otra cosa
// (sort -m .env lee el archivo).
const GIT_MESSAGE = new Set(['commit', 'tag', 'merge', 'stash', 'notes', 'revert', 'cherry-pick']);
const HOST_TEXT = new Set(['-m', '--message', '--body', '--title', '--description', '-t', '-b']);
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls']);
// Las opciones de un buscador que no se llevan el argumento siguiente. Con cualquier otra delante (-e, -f,
// --include, -Path, -Pattern), el primer argumento suelto puede no ser el patrón, y se cuenta como ruta.
const SEARCH_FLAG = /^-[rRnivlcwxHhsqoEFPIazSU]+$|^--(recursive|line-number|ignore-case|invert-match|files-with-matches|count|color(=\w+)?|no-messages|word-regexp|fixed-strings|extended-regexp)$/;

// ¿El texto puede ejecutar algo adentro? $(…), `…`, <(…), ${…} y, fuera de comillas, cualquier paréntesis
// (en PowerShell un paréntesis es una expresión: (Get-Content .env)).
function expands(text) {
  if (/\$\(|`|<\(|\$\{/.test(text)) return true;
  return /\(/.test(String(text).replace(/'[^']*'|"[^"]*"/g, ''));
}
const RUNNERS = [['npx'], ['bunx'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['yarn'], ['npm', 'exec']];

// Git Bash escribe C:\x como /c/x; ~ es el home.
function toPath(dir, p) {
  let q = p;
  if (process.platform === 'win32' && /^\/[a-zA-Z](\/|$)/.test(q)) q = `${q[1]}:${q.slice(2) || '/'}`;
  if (q === '~' || q.startsWith('~/')) q = path.join(os.homedir(), q.slice(1));
  return path.resolve(dir, q);
}

const projects = new Map();
function projectAt(dir) {
  if (!projects.has(dir)) {
    const p = loadProject(dir);
    projects.set(dir, p && !p.errors.length ? p : null);
  }
  return projects.get(dir);
}

function workspaceAt(dir) {
  const project = projectAt(dir);
  if (!project) return { project: null, ws: null };
  const hit = resolveWorkspace(project, dir);
  return { project, ws: hit ? hit.ws : null };
}

function targetsFor(dir) {
  const { ws } = workspaceAt(dir);
  const t = mergeTargets(dir, ws && ws.defaultBranch);
  return t.refs.length ? t : { branch: 'HEAD', refs: ['HEAD'] };
}

// ---------- reglas de git ----------

function splitGit(args, dir) {
  let i = 0;
  let d = dir;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') {
      d = toPath(d, args[i + 1] || '.');
      i += 2;
    } else if (a === '-c' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') i += 2;
    else i++;
  }
  return { dir: d, sub: args[i], rest: args.slice(i + 1) };
}

const shortHas = (args, letter) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

function judgeBranchDelete(dir, rest) {
  const force = shortHas(rest, 'D') || ((rest.includes('--delete') || shortHas(rest, 'd')) && (rest.includes('--force') || shortHas(rest, 'f')));
  if (!force) return null;
  for (const name of rest.filter((a) => !a.startsWith('-'))) {
    const registered = targetOf(dir, { branch: name });
    const own = registered ? [registered, `origin/${registered}`].filter((r) => refExists(dir, r)) : [];
    const { branch, refs } = own.length ? { branch: registered, refs: own } : targetsFor(dir);
    const commits = unmerged(dir, name, refs);
    if (commits && commits.length) {
      return `git branch -D ${name}: tiene ${commits.length} commit(s) que no están en ${branch} (${commits.slice(0, 3).join(', ')}). Intégralos primero o bórrala tú desde tu terminal.`;
    }
  }
  return null;
}

function judgeWorktreeRemove(dir, rest) {
  if (rest[0] !== 'remove') return null;
  const target = rest.slice(1).find((a) => !a.startsWith('-'));
  if (!target) return null;
  const wt = toPath(dir, target);
  if (!fs.existsSync(wt)) return null;
  const links = liveLinks(wt);
  if (links.length && nativeWorktree(wt)) return `git worktree remove ${target}: tiene enlaces del arnés (${links.join(', ')}) que el remove seguiría y borraría lo que hay detrás. Bórralo al salir de la sesión de ese worktree, cuando Claude Code pregunta: quita solo el enlace.`;
  if (links.length) return `git worktree remove ${target}: tiene enlaces del arnés (${links.join(', ')}) que el remove seguiría y borraría lo que hay detrás. Ciérralo con /arnes:worktree integrate o close, que los quita primero.`;
  const head = git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (head.status !== 0) return null;
  const t = targetsOf(wt, head.stdout.trim());
  const { branch, refs } = t.refs.length ? t : targetsFor(wt);
  const commits = unmerged(wt, 'HEAD', refs);
  if (!commits || !commits.length) return null;
  return `git worktree remove ${target}: su rama ${head.stdout.trim()} tiene ${commits.length} commit(s) que no están en ${branch}. Intégralos (git merge --no-ff) antes de borrarlo.`;
}

// El repositorio de git de una carpeta, por su ruta real: un worktree, un nombre corto de Windows o un
// enlace llevan al mismo.
function commonDir(d) {
  const r = git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try {
    const real = fs.realpathSync.native(r.stdout.trim());
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

function judgeCommit(dir, args = []) {
  const { project, ws } = workspaceAt(dir);
  if (!project) return null;
  // Con --git-dir o --work-tree el commit va al repo que nombran, no al de la carpeta donde está la sesión:
  // desde un repo con su verificación al día se commiteaba en otro sin ella.
  if (args.some((a) => /^--(git-dir|work-tree)\b/.test(a))) return 'git commit con --git-dir o --work-tree: no se sabe a qué workspace va. Usa git -C <repo> commit o cd al repo.';
  if (!ws) {
    // Un commit en el repo de la carpeta (su CLAUDE.md, su .gitignore) no es de ningún workspace y pasa.
    // Si el repositorio es el de un workspace (un worktree suyo fuera de su carpeta), o el comando lo
    // redirige con --git-dir o --work-tree, o no se puede saber, se niega como siempre.
    const mine = commonDir(dir);
    const elsewhere = args.some((a) => /^--(git-dir|work-tree)\b/.test(a));
    const ofWorkspace = !mine || elsewhere || project.workspaces.some((w) => commonDir(w.gitRoot) === mine);
    return ofWorkspace ? `git commit: no se sabe a qué workspace va (${dir} no está dentro de ninguno de ${project.name}). Usa git -C <repo> commit o cd al repo.` : null;
  }
  if (!ws.adoptable) return null;
  const r = checkFlag(project, ws);
  if (r.error || r.ok) return null;
  return (
    `git commit en ${ws.name} sin bandera de verificación vigente: ${r.reason}. ` +
    `Verifica con /arnes:verify, que escribe la bandera solo si el gate pasa; nunca la escribas a mano.`
  );
}

function suspicious(file) {
  const base = path.posix.basename(file);
  if (base === '.env') return true;
  if (base.startsWith('.env.') && !/(example|template|sample)$/i.test(base)) return true;
  return /\.log$/i.test(base);
}

function judgeAdd(dir, rest) {
  const { project } = workspaceAt(dir);
  if (!project) return null;
  const all = rest.some((a) => ['-A', '--all'].includes(a) || a === ':/' || a === ':/*');
  const here = rest.some((a) => a === '.' || a === '*');
  if (!all && !here) return null;
  let scope = dir;
  if (all) {
    const top = git(dir, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0) return null;
    scope = top.stdout.trim();
  }
  const r = git(scope, ['ls-files', '--others', '--exclude-standard']);
  if (r.status !== 0) return null;
  const found = lines(r.stdout).filter(suspicious);
  if (!found.length) return null;
  return `git add masivo con archivos sin trackear que no deberían entrar: ${found.slice(0, 5).join(', ')}. Agrega archivos explícitos o ignóralos primero.`;
}

// ---------- descartar cambios sin commitear ----------
// restore, checkout de rutas y checkout o switch forzados botan lo que no está commiteado, igual que
// reset --hard. Se niegan solo si de verdad hay algo que perder: los archivos trackeados con cambios
// (git diff, contra el índice o contra HEAD) en las rutas que nombran.

const TO_LOSE = 'Si de verdad hace falta, lo corre la persona en su terminal; para guardarlo antes, git stash.';

// Los archivos con cambios que se perderían, o [] si no hay nada o git falla. Un borrado no cuenta:
// devolverlo no pierde nada. Sin vsHead, el árbol contra el índice; con vsHead, también se pierde lo
// staged, así que suma el índice contra HEAD (un cambio staged con el árbol igual a HEAD también).
function changed(dir, paths, vsHead, sides = false) {
  const diff = (extra) => {
    const r = git(dir, ['diff', '--name-only', '--diff-filter=d', ...extra, '--', ...paths]);
    return r.status === 0 ? lines(r.stdout) : [];
  };
  const all = [...new Set(vsHead ? [...diff(['HEAD']), ...diff(['--cached'])] : diff([]))];
  if (!sides || vsHead) return all;
  const conflicted = new Set(lines(git(dir, ['diff', '--name-only', '--diff-filter=U', '--', ...paths]).stdout));
  return all.filter((f) => !conflicted.has(f));
}

// --ours, --theirs, --merge o --conflict sobre rutas: resolver un conflicto, no descartar.
const takesSide = (rest) => rest.some((a) => a === '--ours' || a === '--theirs' || a === '--merge' || a.startsWith('--conflict'));

const lostText = (what, files) => `${what} descarta los cambios sin commitear de ${files.length} archivo(s) (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}) sin vuelta. ${TO_LOSE}`;

// git restore: solo --staged saca del índice y no pierde nada; el resto pisa el árbol, desde el
// índice o, con --source, desde otro árbol.
function judgeRestore(dir, rest) {
  const staged = rest.some((a) => a === '--staged') || shortHas(rest, 'S');
  const worktree = rest.some((a) => a === '--worktree') || shortHas(rest, 'W');
  if (staged && !worktree) return null;
  const paths = [];
  let source = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      paths.push(...rest.slice(i + 1));
      break;
    }
    if (a === '-s' || a === '--source') {
      source = true;
      i++;
    } else if (a.startsWith('--source=') || /^-s./.test(a)) source = true;
    else if (!a.startsWith('-')) paths.push(a);
  }
  if (!paths.length) return null;
  const files = changed(dir, paths, source || staged, takesSide(rest));
  return files.length ? lostText('git restore', files) : null;
}

const isCommit = (dir, ref) => git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;

// git checkout: crear una rama no pierde nada; forzar el cambio de rama bota todo lo sin commitear;
// las rutas (después de --, o las que existen y no son una referencia) se pisan desde el índice o
// desde la referencia que va delante.
function judgeCheckout(dir, rest, sub) {
  if (rest.some((a) => ['-b', '-B', '--orphan', '-c', '-C', '--create', '--force-create'].includes(a))) return null;
  if (sub === 'switch') {
    const force = rest.includes('--discard-changes') || rest.includes('--force') || shortHas(rest, 'f');
    const files = force ? changed(dir, [], true) : [];
    return files.length ? lostText('git switch forzado', files) : null;
  }
  if (rest.includes('--force') || shortHas(rest, 'f')) {
    const files = changed(dir, [], true);
    if (files.length) return lostText('git checkout forzado', files);
  }
  const dd = rest.indexOf('--');
  const words = (dd >= 0 ? rest.slice(0, dd) : rest).filter((a) => !a.startsWith('-'));
  const tree = words.length && isCommit(dir, words[0]);
  const paths = dd >= 0 ? rest.slice(dd + 1) : words.slice(tree ? 1 : 0).filter((a) => a === '.' || fs.existsSync(toPath(dir, a)));
  if (!paths.length) return null;
  const files = changed(dir, paths, tree, takesSide(rest));
  return files.length ? lostText('git checkout de rutas', files) : null;
}

// git stash drop o clear: lo que se borra de la pila no se recupera sin buscar en los objetos sueltos.
function judgeStash(dir, rest) {
  const op = rest.find((a) => !a.startsWith('-'));
  if (op !== 'drop' && op !== 'clear') return null;
  const list = git(dir, ['stash', 'list']);
  if (list.status !== 0 || !list.stdout.trim()) return null;
  return `git stash ${op} borra cambios guardados que después no se recuperan. Si de verdad hace falta, lo corre la persona en su terminal.`;
}

function judgeGit(args, dir) {
  const g = splitGit(args, dir);
  const { sub, rest } = g;
  if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard descarta trabajo sin vuelta. Si de verdad hace falta, lo corre la persona en su terminal.';
  // --merge bota lo staged cuyo árbol es igual al índice; --keep conserva los cambios locales o aborta.
  if (sub === 'reset' && rest.includes('--merge')) {
    const files = changed(g.dir, [], true);
    if (files.length) return lostText('git reset --merge', files);
  }
  if (sub === 'push' && (rest.some((a) => /^--force(-with-lease|-if-includes)?(=|$)/.test(a)) || shortHas(rest, 'f') || rest.some((a) => /^\+/.test(a)))) {
    return 'el push forzado reescribe historia remota. Si de verdad hace falta, lo corre la persona en su terminal.';
  }
  if (sub === 'push' && (['--delete', '--prune', '--mirror'].some((o) => rest.includes(o)) || shortHas(rest, 'd') || rest.some((a) => /^:./.test(a)))) {
    return 'el push que borra ramas del remoto las quita para todos. Si de verdad hace falta, lo corre la persona en su terminal.';
  }
  if (sub === 'restore') return judgeRestore(g.dir, rest);
  if (sub === 'checkout' || sub === 'switch') return judgeCheckout(g.dir, rest, sub);
  if (sub === 'stash') return judgeStash(g.dir, rest);
  if (sub === 'clean' && (shortHas(rest, 'f') || rest.includes('--force')) && !(shortHas(rest, 'n') || rest.includes('--dry-run'))) {
    return 'git clean -f borra archivos sin trackear sin vuelta. Si de verdad hace falta, lo corre la persona en su terminal.';
  }
  if (sub === 'branch') return judgeBranchDelete(g.dir, rest);
  if (sub === 'worktree') return judgeWorktreeRemove(g.dir, rest);
  if (sub === 'commit') return judgeConfigCommit(g.dir, rest) || judgeCommit(g.dir, args);
  if (sub === 'add') return judgeAdd(g.dir, rest);
  return null;
}

// ---------- lectura de secretos ----------

// Las rutas que nombra un comando: cada pedazo de cada argumento que puede ser una ruta, sin el
// destino de una redirección de salida ni el marcador de heredoc. Un `cat < .env` también la nombra.
// No cuenta el texto libre: el valor de -m, --body o --title, el patrón de un buscador (su primer argumento
// que no es opción) y todo lo que escribe un echo. «git commit -m "valida credentials"» se negaba por nombrar
// un archivo de credenciales, y «grep -rn credentials src/», por lo mismo.
// exe solo llega cuando el comando no puede leer nada por otro lado (judgeSecrets relax): sin él, todo cuenta.
function namedPaths(args, exe = '', gitSub = '') {
  if (TEXT_ONLY.has(exe)) return [];
  const out = [];
  const message = exe === 'git' && GIT_MESSAGE.has(gitSub);
  const text = message ? (a) => a === '-m' || a === '--message' : exe === 'gh' || exe === 'glab' ? (a) => HOST_TEXT.has(a) : () => false;
  const texted = message || exe === 'gh' || exe === 'glab';
  let pattern = SEARCHERS.has(exe);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^[0-9&]?>>?$/.test(a)) i++;
    else if (text(a)) i++;
    else if (texted && /^--(message|body|title|description)=/.test(a)) continue;
    else if (pattern && !/^[-/<]/.test(a)) pattern = false;
    else {
      if (pattern && !SEARCH_FLAG.test(a)) pattern = false;
      if (!/^[0-9&]?>/.test(a) && a !== '<<HEREDOC') out.push(...a.replace(/^</, '').split(/[\s'"`()[\]{},;=|&<>$]+/).filter(Boolean));
    }
  }
  return out;
}

// Copiar un .env por el shell se niega como leerlo; el arnés lo copia a un worktree sin mostrarlo.
const COPIERS = new Set(['cp', 'copy', 'xcopy', 'robocopy', 'copy-item', 'cpi', 'install', 'rsync']);
const EQUIPAR = path.join(__dirname, '..', 'worktree-carpeta.js').split(path.sep).join('/');

function judgeSecrets(cmd, piece, dir, namesOnly = false, line = { calm: false, alone: false }) {
  const { project } = workspaceAt(dir);
  // Lo aflojado (listar, el texto de un echo o de un mensaje, el patrón de un buscador) vale solo si nada
  // puede abrir después lo que el comando nombra: la línea entera no usa variables ni expansiones (cat $_
  // lee el último argumento del comando anterior), su salida no sigue por tubería más que a formateadores
  // de nombres, y si la manda a un archivo, el comando va solo.
  const toFile = cmd.args.some((a) => /^[0-9&]?>/.test(a));
  const relax = line.calm && !expands(piece.text) && (piece.sep !== '|' || namesOnly) && (!toFile || line.alone);
  const gitSub = cmd.exe === 'git' ? splitGit(cmd.args, dir).sub : '';
  const hit = namedPaths(cmd.args, relax ? cmd.exe : '', gitSub).map((p) => ({ p, abs: toPath(dir, p) })).find((x) => secretPath(x.abs, project));
  if (!hit) return null;
  if (LISTERS.has(cmd.exe) && relax) return null;
  const shown = maskedFile(hit.abs, project);
  const copy = COPIERS.has(cmd.exe) ? ` Para llevar los .env a un worktree, corre node "${EQUIPAR}" equipar --dir <carpeta del worktree>: los copia del checkout principal sin mostrarlos.` : '';
  const why = secretPath(hit.abs, project);
  return `${cmd.raw} ${hit.p}: ${why}${deniedText(why, shown)}${copy}`;
}

// ---------- configuración del proyecto ----------
// La de lib/configuracion.js. Fuera de init o setup en curso, un comando que la nombra solo pasa si
// la lee; la redirección de salida hacia ella nunca. Uno que borra o mueve la carpeta que la tiene
// (el repo o su .claude/), tampoco. Un commit no la lleva: ni lo staged, ni lo modificado con -a.

const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'select-string', 'sls', 'findstr', 'jq', 'wc', 'diff', 'ls', 'dir', 'get-childitem', 'gci', 'stat', 'test-path', 'echo', 'printf', 'write-output', 'nl', 'cut', 'file', 'test', '[', 'get-item', 'gi']);
const GIT_READS = new Set(['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'cat-file', 'grep']);
const MOVERS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);

// Los destinos de las redirecciones de salida (> f, >> f, 2>f), sin los de un descriptor (2>&1).
function redirectTargets(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (/^[0-9&]?>>?$/.test(args[i])) {
      if (args[i + 1]) out.push(args[i + 1]);
      i++;
      continue;
    }
    const m = /^[0-9&]?>>?(.+)$/.exec(args[i]);
    if (m && !/^&\d$/.test(m[1])) out.push(m[1]);
  }
  return out;
}

// La carpeta tiene configuración directa: es un repo o carpeta con .claude/harness.json, o su .claude/.
// Un worktree bajo .claude/worktrees/ no cuenta: borrarlo no apaga el arnés del checkout (lo cuidan
// ExitWorktree y git worktree remove).
const holdsConfig = (abs) =>
  !/[\\/]\.claude[\\/]worktrees[\\/]/i.test(abs) &&
  (fs.existsSync(path.join(abs, '.claude', 'harness.json')) || (path.basename(abs) === '.claude' && fs.existsSync(path.join(abs, 'harness.json'))));

const CONFIG_WHY = `es configuración del proyecto (las reglas del arnés, o los permisos, hooks o reglas de Claude Code): fuera de /arnes:init, setup o un ajuste aprobado, por el shell solo se lee. ${AJUSTE}`;

// La primera de esas rutas que es configuración de un proyecto sin init ni setup en curso, o null.
// holder: en vez de la configuración misma, la carpeta que la tiene.
function liveConfig(list, dir, holder = false) {
  for (const p of list) {
    const abs = toPath(dir, p);
    const root = holder ? (holdsConfig(abs) ? (path.basename(abs) === '.claude' ? path.dirname(abs) : abs) : null) : configRoot(abs);
    const home = root && configHome(root);
    if (home && !prepAt(home)) return p;
  }
  return null;
}

// ajuste.js del propio arnés nombra la configuración para proponer un cambio, y no la escribe: la abre
// solo con la respuesta de la persona (lib/configuracion.js AJUSTE).
const samePath = (a, b) => path.resolve(a).replace(/\\/g, '/').toLowerCase() === path.resolve(b).replace(/\\/g, '/').toLowerCase();
const MANIFEST_JS = path.join(__dirname, '..', 'lib', 'manifest.js');
const isAjuste = (cmd, dir) => cmd.exe === 'node' && Boolean(cmd.args[0]) && [AJUSTE_JS, MANIFEST_JS].some((f) => samePath(toPath(dir, cmd.args[0]), f));

function judgeConfig(cmd, dir, piece = { text: '' }) {
  const out = liveConfig(redirectTargets(cmd.args), dir);
  if (out) return `${cmd.raw} > ${out}: ${CONFIG_WHY}`;
  const gitSub = cmd.exe === 'git' ? splitGit(cmd.args, dir).sub : '';
  const reads = cmd.exe === 'git' ? GIT_READS.has(gitSub) : READERS.has(cmd.exe) || isAjuste(cmd, dir);
  // El mensaje de un commit o el cuerpo de un MR que nombra la configuración no la toca.
  const texted = ['git', 'gh', 'glab'].includes(cmd.exe) && !expands(piece.text);
  const hit = reads ? null : liveConfig(namedPaths(cmd.args, texted ? cmd.exe : '', gitSub), dir);
  if (hit) return `${cmd.raw} ${hit}: ${CONFIG_WHY}`;
  const holder = MOVERS.has(cmd.exe) ? liveConfig(namedPaths(cmd.args), dir, true) : null;
  return holder ? `${cmd.raw} ${holder}: borra o mueve una carpeta con configuración del proyecto, y sin ella el arnés se apaga. Si de verdad hace falta, lo corre la persona en su terminal.` : null;
}

// El commit que lleva configuración fuera de init o setup, en un repo del arnés (con manifiesto en el
// árbol o en HEAD). Mira git, no el proyecto cargado: así vale aunque el manifiesto ya no esté.
function judgeConfigCommit(dir, rest) {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const root = path.resolve(top.stdout.trim());
  const home = configHome(root);
  if (!home || prepAt(home)) return null;
  const list = (extra) => {
    const r = git(root, ['diff', '--name-only', ...extra, '--', ...CONFIG_SPEC]);
    return r.status === 0 ? lines(r.stdout) : [];
  };
  const all = rest.includes('--all') || shortHas(rest, 'a');
  const files = [...new Set([...list(['--cached']), ...(all ? list([]) : [])])];
  if (!files.length) return null;
  return `git commit con configuración del proyecto (${files.slice(0, 3).join(', ')}) fuera de /arnes:init o setup: la commitea la persona, que decide si queda.`;
}

// ---------- forbidden del manifiesto ----------

function variants(cmd) {
  const toks = [cmd.exe, ...cmd.args];
  const out = [toks];
  for (const r of RUNNERS) {
    if (r.every((w, i) => toks[i] === w)) {
      let i = r.length;
      while (toks[i] && toks[i].startsWith('-')) i++;
      out.push(toks.slice(i));
    }
  }
  return out;
}

// Un comando de afterBuild del workspace, tal cual, con su condición de base local cumplida: lo único
// de forbidden que pasa, porque build lo corre solo contra la base local del .env (docs/PLAN.md §8).
function fromAfterBuild(cmd, ws) {
  const ab = ws && ws.afterBuild;
  if (!ab || !ab.onlyIfLocalDb) return false;
  const toks = [cmd.exe, ...cmd.args];
  const same = (c) => {
    const want = tokenize(c);
    return want.length === toks.length && want.every((w, i) => (i === 0 ? toks[i].toLowerCase() === w.toLowerCase() : toks[i] === w));
  };
  return (ab.commands || []).some(same) && localDb(ws).ok;
}

function judgeForbidden(cmd, dir) {
  const { project, ws } = workspaceAt(dir);
  if (!project) return null;
  const list = ws ? ws.forbidden || [] : project.workspaces.flatMap((w) => w.forbidden || []);
  for (const f of list) {
    const want = tokenize(f);
    if (variants(cmd).some((v) => want.every((w, i) => (i === 0 ? v[i] && v[i].toLowerCase() === w.toLowerCase() : v[i] === w)))) {
      if (fromAfterBuild(cmd, ws)) return null;
      const where = `"${f}" está en forbidden de ${ws ? ws.name : project.name}`;
      if (touchesDatabase(f)) return `${where}: toca una base: lo corre la persona desde su terminal, sabiendo contra qué base apunta el .env.`;
      return `${where}: reescribe archivos en masa o es destructivo. Usa el comando equivalente sin efectos (por ejemplo, el lint del manifiesto sobre los archivos tocados).`;
    }
  }
  return null;
}

// ---------- recorrido ----------

function judge(text, dir, depth = 0, dialect = 'bash') {
  let cwd = dir;
  const all = [...pieces(text, dialect)];
  const line = { calm: !/\$/.test(text) && !expands(text), alone: all.length === 1 };
  for (let n = 0; n < all.length; n++) {
    const piece = all[n];
    const cmd = command(piece.text, dialect);
    if (!cmd) continue;
    // ¿Todo lo que recibe la salida de este comando por tubería solo da forma a nombres?
    let namesOnly = piece.sep === '|';
    for (let j = n; namesOnly && j < all.length && all[j].sep === '|'; j++) {
      const next = all[j + 1] && command(all[j + 1].text, dialect);
      namesOnly = Boolean(next && NAMERS.has(next.exe) && PLAIN.test(all[j + 1].text) && !FROM_INPUT.test(all[j + 1].text));
    }
    if (CD.has(cmd.exe)) {
      const target = cmd.args.find((a) => !a.startsWith('-') && a.toLowerCase() !== '/d');
      if (target && target !== '-') cwd = toPath(cwd, target);
      continue;
    }
    const nested = depth < 3 ? nestedCommand(cmd) : null;
    if (nested) {
      const why = judge(nested.text, cwd, depth + 1, nested.dialect);
      if (why) return why;
      continue;
    }
    const why = judgeSecrets(cmd, piece, cwd, namesOnly, line) || judgeConfig(cmd, cwd, piece) || judgeForbidden(cmd, cwd) || (cmd.exe === 'git' ? judgeGit(cmd.args, cwd) : null);
    if (why) return why;
  }
  return null;
}

module.exports = { judge, suspicious };

if (require.main === module) {
  run('guard', (input) => {
    const text = input.tool_input && input.tool_input.command;
    if (!text) return null;
    const why = judge(text, path.resolve(input.cwd || process.cwd()), 0, input.tool_name === 'PowerShell' ? 'powershell' : 'bash');
    return why ? deny(`arnes guard: ${why}`) : null;
  });
}
