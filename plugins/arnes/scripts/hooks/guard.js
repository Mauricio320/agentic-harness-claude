#!/usr/bin/env node
// PreToolUse sobre Bash y PowerShell (docs/PLAN.md §6.2). Parte el comando en segmentos con
// lib/shell.js y juzga cada uno solo por el ejecutable con que empieza: nunca mira el cuerpo de
// un heredoc ni los argumentos de echo o grep. De cat, type, Get-Content (gc) y head mira solo
// los archivos que leen, nunca texto libre. El directorio de cada segmento sigue los cd
// anteriores y el -C de git, a partir del cwd del JSON de entrada (nunca CLAUDE_PROJECT_DIR).
//
// Deniega siempre, haya o no manifiesto:
//   git reset --hard · git push forzado (--force, -f, --force-with-lease, refspec +) ·
//   git clean -f · git branch -D de una rama con commits fuera de su destino ·
//   git worktree remove de un worktree cuya rama tiene commits fuera de su destino ·
//   cat, type, Get-Content o head de un archivo de secretos (los de read-guard.js: .env y
//   variantes salvo .env.example, ~/.ssh, ~/.aws, credenciales, llaves, tokens; con manifiesto,
//   además secretPaths)
// El destino de una rama es el registrado en .tmp/harness/worktrees.json si es de un worktree
// abierto del registro; si no, la rama por defecto del workspace.
// Deniega solo con manifiesto:
//   los comandos de `forbidden` del workspace (o de todos, si no se sabe cuál), salvo uno de su
//   afterBuild con la condición onlyIfLocalDb cumplida (lib/database.js localDb); los que tocan una
//   base (lib/database.js) con su propio motivo: los corre la persona desde su terminal ·
//   git commit sin bandera vigente (gate-flag.js) para ese workspace, o sin workspace claro ·
//   git add masivo (., -A, --all, :/, *) con .env o *.log sin trackear en su alcance
// Además, sin juzgar nada, anota en la timeline del proyecto cada consulta al grafo (graphify query,
// explain o path): la nota "consulta" de la etapa grafo, que plan cuenta en su sección Mapa
// consultado y arnes-ui muestra en la etapa (docs/PLAN.md §6.3).
// Salida: JSON con permissionDecision "deny" y el motivo; nada si permite. Siempre exit 0.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, deny } = require('../lib/hook.js');
const { append } = require('../lib/timeline.js');
const { segments, command, nestedCommand, tokenize } = require('../lib/shell.js');
const { loadProject, resolveWorkspace } = require('../lib/manifest.js');
const { git, lines } = require('../lib/exec.js');
const { mergeTargets, unmerged, refExists } = require('../lib/branches.js');
const { checkFlag } = require('../gate-flag.js');
const { targetOf, liveLinks } = require('../worktree-ledger.js');
const { targetsOf } = require('./worktree-remove.js');
const { secretPath } = require('./read-guard.js');
const { touchesDatabase, localDb } = require('../lib/database.js');
const { nativeWorktree } = require('../lib/worktree-nativo.js');

const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const READERS = new Set(['cat', 'type', 'get-content', 'gc', 'head']);
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

function judgeCommit(dir) {
  const { project, ws } = workspaceAt(dir);
  if (!project) return null;
  if (!ws) return `git commit: no se sabe a qué workspace va (${dir} no está dentro de ninguno de ${project.name}). Usa git -C <repo> commit o cd al repo.`;
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

function judgeGit(args, dir) {
  const g = splitGit(args, dir);
  const { sub, rest } = g;
  if (sub === 'reset' && rest.includes('--hard')) return 'git reset --hard descarta trabajo sin vuelta. Si de verdad hace falta, lo corre la persona en su terminal.';
  if (sub === 'push' && (rest.some((a) => /^--force(-with-lease|-if-includes)?(=|$)/.test(a)) || shortHas(rest, 'f') || rest.some((a) => /^\+/.test(a)))) {
    return 'el push forzado reescribe historia remota. Si de verdad hace falta, lo corre la persona en su terminal.';
  }
  if (sub === 'clean' && (shortHas(rest, 'f') || rest.includes('--force')) && !(shortHas(rest, 'n') || rest.includes('--dry-run'))) {
    return 'git clean -f borra archivos sin trackear sin vuelta. Si de verdad hace falta, lo corre la persona en su terminal.';
  }
  if (sub === 'branch') return judgeBranchDelete(g.dir, rest);
  if (sub === 'worktree') return judgeWorktreeRemove(g.dir, rest);
  if (sub === 'commit') return judgeCommit(g.dir);
  if (sub === 'add') return judgeAdd(g.dir, rest);
  return null;
}

// ---------- lectura de secretos ----------

// Los archivos que lee un cat, type, Get-Content o head: sus argumentos sin opciones, sin el
// destino de una redirección de salida y sin el marcador de heredoc. Un `cat < .env` también lee.
function readTargets(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^[0-9&]?>>?$/.test(a)) i++;
    else if (!/^[0-9&]?>/.test(a) && !a.startsWith('-') && a !== '<<HEREDOC') out.push(a.replace(/^</, ''));
  }
  return out.filter(Boolean);
}

function judgeRead(cmd, dir) {
  const { project } = workspaceAt(dir);
  for (const a of readTargets(cmd.args)) {
    const why = secretPath(toPath(dir, a), project);
    if (why) return `${cmd.raw} ${a}: ${why}. Los secretos no entran al transcript; si hace falta un valor, pídeselo a la persona, o lee .env.example.`;
  }
  return null;
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

// ---------- evidencia del grafo ----------

const GRAPH_QUERIES = new Set(['query', 'explain', 'path']);

// Una consulta al grafo queda en la timeline del proyecto donde corre. Nunca frena el juicio.
function noteGraph(cmd, dir) {
  if (cmd.exe !== 'graphify' || !GRAPH_QUERIES.has(cmd.args[0])) return;
  try {
    const project = projectAt(dir);
    const words = cmd.args.filter((a) => !/^\d?>>?(&\d)?$|^[<>|&]|^\d?>&/.test(a));
    if (project) append(project.root, { event: 'note', stage: 'grafo', result: 'consulta', detail: words.join(' ').slice(0, 160) });
  } catch {
    /* la medición no frena el guard */
  }
}

// ---------- recorrido ----------

function judge(text, dir, depth = 0) {
  let cwd = dir;
  for (const seg of segments(text)) {
    const cmd = command(seg);
    if (!cmd) continue;
    if (CD.has(cmd.exe)) {
      const target = cmd.args.find((a) => !a.startsWith('-') && a.toLowerCase() !== '/d');
      if (target && target !== '-') cwd = toPath(cwd, target);
      continue;
    }
    const nested = depth < 3 ? nestedCommand(cmd) : null;
    if (nested) {
      const why = judge(nested, cwd, depth + 1);
      if (why) return why;
      continue;
    }
    noteGraph(cmd, cwd);
    const why = (READERS.has(cmd.exe) && judgeRead(cmd, cwd)) || judgeForbidden(cmd, cwd) || (cmd.exe === 'git' ? judgeGit(cmd.args, cwd) : null);
    if (why) return why;
  }
  return null;
}

module.exports = { judge, suspicious };

if (require.main === module) {
  run('guard', (input) => {
    const text = input.tool_input && input.tool_input.command;
    if (!text) return null;
    const why = judge(text, path.resolve(input.cwd || process.cwd()));
    return why ? deny(`arnes guard: ${why}`) : null;
  });
}
