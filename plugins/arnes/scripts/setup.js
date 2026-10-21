#!/usr/bin/env node
// Lo determinista de /arnes:setup (docs/PLAN.md §8): deja listo desde cero un proyecto ya adoptado,
// a partir de su repo de carpeta, el que versiona la composición, el CLAUDE.md de la carpeta, el
// .claude/settings.json con el marketplace y un .gitignore con los repos anidados. Cada paso es
// idempotente: sin --write solo dice qué haría, y con --write lo hace y deja igual lo que ya está.
//   clone [<url o ruta> [destino]]  clona el repo de carpeta en destino (por defecto, el nombre del
//                           repo en el cwd); sin fuente, o si el destino ya tiene composición, usa esa
//   repos [--switch <ruta>]...  por cada repo de la composición: lo clona si falta (con su branch, o
//                           la rama por defecto), y si existe hace fetch y lo deja en la rama
//                           declarada. Un repo en otra rama no se mueve sin --switch <su ruta>, ni
//                           con cambios sin commitear
//   deps [--repo <ruta>]...  instala dependencias según el lockfile: pnpm install --frozen-lockfile,
//                           npm ci o yarn install --frozen-lockfile; uno con node_modules más nuevo
//                           que el lockfile está al día
//   env                     si hay .env.example y no .env, lo copia; lista las variables vacías, que
//                           llena la persona, y a qué host apunta cada una que parezca una conexión a
//                           base. Nunca escribe un valor ni imprime uno que no sea un host
//   probe                   el comando de test de cada workspace sobre un spec (adopt.js probe)
//   baseline [--ws n]...    la línea base de tests commiteada; con --write, la captura donde falta
//   graph                   si graphify está instalado, extrae el grafo de cada repo (graphify
//                           update) y los mergea en <carpeta>/graphify-out/graph.json; si no, dice
//                           cómo instalarlo
//   claude-md               el CLAUDE.md de la carpeta si falta (adopt.js claude-md)
//   permissions             los permisos en .claude/settings.local.json (adopt.js permissions)
//   close                   corre adoption-check (init --check) y lista lo pendiente de la persona:
//                           valores de .env, comandos contra la base, permisos de la app
// Todos menos clone aceptan --dir <carpeta> (por defecto, el cwd). Nunca corre un comando de
// forbidden ni escribe credenciales.
// Exit: 0 hecho o nada que hacer · 1 algo queda pendiente o falló (lo dice) · 2 uso inválido o sin
//       composición

'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { spawnSync } = require('child_process');
const { MANIFEST, validate, requireProject, posix } = require('./lib/manifest.js');
const { git, sh, quote, firstLine, lines, help, die } = require('./lib/exec.js');
const { touchesDatabase, parseEnv, DB_URL, DB_VAR: DB_NAME } = require('./lib/database.js');
const tb = require('./test-baseline.js');
const adopt = require('./adopt.js');

const LOCKS = [
  { file: 'pnpm-lock.yaml', cmd: 'pnpm install --frozen-lockfile', marker: '.modules.yaml' },
  { file: 'package-lock.json', cmd: 'npm ci', marker: '.package-lock.json' },
  { file: 'yarn.lock', cmd: 'yarn install --frozen-lockfile', marker: '.yarn-integrity' },
];
const GRAPHIFY = 'https://github.com/Graphify-Labs/graphify';

const rel = (dir, p) => posix(path.relative(dir, p)) || '.';

// La composición de la carpeta, leída a mano: los repos todavía pueden no existir.
function composition(dir) {
  const file = path.join(dir, MANIFEST);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.repos)) return null;
  const errs = validate(data);
  if (errs.length) die(`setup: ${file} no valida:\n  ${errs.join('\n  ')}`);
  return data;
}

function requireComposition(dir) {
  const c = composition(dir);
  if (!c) die(`setup: ${dir} no tiene composición (${posix(MANIFEST)} con repos); corre primero setup.js clone`);
  return c;
}

const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));
const branchOf = (dir) => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();

function defaultOf(dir) {
  const head = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0) return head.stdout.trim().replace(/^origin\//, '');
  return ['main', 'master'].find((b) => git(dir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${b}`]).status === 0) || null;
}

function clone(source, dest, write) {
  const target = path.resolve(dest || (source ? path.basename(source).replace(/\.git$/, '') : '.'));
  if (composition(target)) {
    console.log(`clone: ${target} ya tiene composición; uso esa carpeta`);
    return 0;
  }
  if (!source) {
    console.log(`clone: ${target} no tiene composición; pasa la url o la ruta del repo de carpeta`);
    return 1;
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    console.log(`clone: ${target} existe y no tiene composición; elige otro destino`);
    return 1;
  }
  if (!write) {
    console.log(`clone: clonaría ${source} en ${target}`);
    return 0;
  }
  const r = git(path.dirname(target), ['clone', source, target]);
  if (r.status !== 0) {
    console.log(`clone: git clone falló: ${firstLine(r.stderr)}`);
    return 1;
  }
  if (!composition(target)) {
    console.log(`clone: ${source} no trae ${posix(MANIFEST)} con repos: no es un repo de carpeta`);
    return 1;
  }
  console.log(`clone: ${source} clonado en ${target}`);
  return 0;
}

function repos(dir, switches, write) {
  const c = requireComposition(dir);
  let pending = 0;
  for (const entry of c.repos) {
    const target = path.resolve(dir, entry.path);
    const say = (msg) => console.log(`${entry.path}: ${msg}`);
    const wanted = entry.branch ? `la rama ${entry.branch}` : 'la rama por defecto';
    if (!fs.existsSync(target)) {
      if (!entry.remote) {
        say('falta y la composición no trae su remote; clónalo a mano');
        pending++;
        continue;
      }
      if (!write) {
        say(`clonaría ${entry.remote} en ${wanted}`);
        continue;
      }
      const r = git(dir, ['clone', ...(entry.branch ? ['-b', entry.branch] : []), entry.remote, target]);
      if (r.status !== 0) {
        say(`git clone falló: ${firstLine(r.stderr)}`);
        pending++;
        continue;
      }
      say(`clonado en ${branchOf(target)}`);
      continue;
    }
    if (!isRepo(target)) {
      say('existe y no es un repo de git; muévelo y vuelve a correr este paso');
      pending++;
      continue;
    }
    if (write && git(target, ['remote']).stdout.trim()) {
      const f = git(target, ['fetch', '--prune', 'origin']);
      if (f.status !== 0) say(`git fetch falló: ${firstLine(f.stderr)}; sigo con lo que hay`);
    }
    const want = entry.branch || defaultOf(target);
    const cur = branchOf(target);
    if (!want) {
      say(`en ${cur}; sin branch en la composición ni rama por defecto conocida, no lo muevo`);
      continue;
    }
    if (cur === want) {
      const behind = git(target, ['rev-list', '--count', `HEAD..origin/${want}`]);
      const n = behind.status === 0 ? Number(behind.stdout.trim()) : 0;
      say(`en ${want}${n ? ` · ${n} commit(s) detrás de origin/${want}: tráelos tú con git pull` : ''}`);
      continue;
    }
    if (!switches.some((s) => path.resolve(dir, s) === target)) {
      say(`está en ${cur} y la composición dice ${want}; no lo muevo sin un sí (--switch ${entry.path})`);
      pending++;
      continue;
    }
    const dirty = lines(git(target, ['status', '--porcelain', '--untracked-files=no']).stdout);
    if (dirty.length) {
      say(`está en ${cur} con ${dirty.length} archivo(s) sin commitear; no lo muevo a ${want}`);
      pending++;
      continue;
    }
    if (!write) {
      say(`lo cambiaría de ${cur} a ${want}`);
      continue;
    }
    const s = git(target, ['switch', want]);
    if (s.status !== 0) {
      say(`git switch ${want} falló: ${firstLine(s.stderr)}`);
      pending++;
      continue;
    }
    say(`de ${cur} a ${want}`);
  }
  return pending ? 1 : 0;
}

// Lo que se instala en un repo: { lock, cmd, fresh } o null sin package.json.
function depsOf(target) {
  if (!fs.existsSync(path.join(target, 'package.json'))) return null;
  const lock = LOCKS.find((l) => fs.existsSync(path.join(target, l.file)));
  if (!lock) return { lock: null };
  const marker = path.join(target, 'node_modules', lock.marker);
  const fresh = fs.existsSync(marker) && fs.statSync(marker).mtimeMs >= fs.statSync(path.join(target, lock.file)).mtimeMs;
  return { lock, cmd: lock.cmd, fresh };
}

function forbiddenIn(dir) {
  const p = requireProject(dir);
  return p.workspaces.flatMap((w) => w.forbidden || []);
}

// Instala las dependencias de una carpeta según su lockfile, o dice qué haría. Lo usan el paso deps
// y worktree-ledger.js open --no-link. → true si queda algo pendiente
function installIn(target, forbidden, write, say) {
  const d = depsOf(target);
  if (!d) return false;
  if (!d.lock) {
    say('package.json sin lockfile; no instalo: decide tú con qué');
    return true;
  }
  if (d.fresh) {
    say(`dependencias al día (node_modules más nuevo que ${d.lock.file})`);
    return false;
  }
  if (forbidden.includes(d.cmd)) {
    say(`${d.cmd} está en forbidden; no lo corro`);
    return true;
  }
  if (!write) {
    say(`instalaría con ${d.cmd} (${d.lock.file})`);
    return false;
  }
  say(`${d.cmd}…`);
  const r = spawnSync(d.cmd, { cwd: target, shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    say(`${d.cmd} salió con ${r.status}`);
    return true;
  }
  say(`instalado con ${d.cmd}`);
  return false;
}

function deps(dir, only, write) {
  const c = requireComposition(dir);
  const forbidden = forbiddenIn(dir);
  let pending = 0;
  for (const entry of c.repos.filter((e) => !only.length || only.some((o) => path.resolve(dir, o) === path.resolve(dir, e.path)))) {
    const target = path.resolve(dir, entry.path);
    const say = (msg) => console.log(`${entry.path}: ${msg}`);
    if (!fs.existsSync(target)) {
      say('no existe; corre antes el paso repos');
      pending++;
      continue;
    }
    if (installIn(target, forbidden, write, say)) pending++;
  }
  return pending ? 1 : 0;
}

// A qué host apunta cada variable que parece una conexión a base: [{ key, host }]. Solo el host y el
// puerto: ni usuario, ni contraseña, ni base.
function dbHosts(vars) {
  const out = [];
  for (const { key, value } of vars) {
    if (!value) continue;
    if (DB_URL.test(value)) {
      try {
        const u = new URL(value);
        out.push({ key, host: u.port ? `${u.hostname}:${u.port}` : u.hostname });
      } catch {
        /* url ilegible: no se adivina */
      }
    } else if (DB_NAME.test(key) && /_HOST$/i.test(key)) {
      const port = vars.find((x) => x.key === key.replace(/_HOST$/i, '_PORT'));
      out.push({ key, host: port && port.value ? `${value}:${port.value}` : value });
    }
  }
  return out;
}

const local = (host) => /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i.test(host);

// El .env de cada repo: → [{ path, empty: [claves], hosts }]
function envState(dir, c) {
  const out = [];
  for (const entry of c.repos) {
    const target = path.resolve(dir, entry.path);
    const example = path.join(target, '.env.example');
    const env = path.join(target, '.env');
    if (!fs.existsSync(example) && !fs.existsSync(env)) continue;
    const vars = parseEnv(fs.readFileSync(fs.existsSync(env) ? env : example, 'utf8'));
    out.push({ path: entry.path, hasEnv: fs.existsSync(env), hasExample: fs.existsSync(example), empty: vars.filter((v) => !v.value).map((v) => v.key), hosts: dbHosts(vars) });
  }
  return out;
}

function envStep(dir, write) {
  const c = requireComposition(dir);
  let pending = 0;
  for (const e of envState(dir, c)) {
    const say = (msg) => console.log(`${e.path}: ${msg}`);
    if (e.hasEnv) say('ya tiene .env; no lo toco');
    else if (!write) say('copiaría .env.example a .env');
    else {
      fs.copyFileSync(path.join(dir, e.path, '.env.example'), path.join(dir, e.path, '.env'));
      say('.env copiado de .env.example');
    }
    if (e.empty.length) {
      pending++;
      say(`variables vacías, las llenas tú: ${e.empty.join(', ')}`);
    }
    for (const h of e.hosts) say(`${h.key} apunta a ${h.host}${local(h.host) ? ' (local o un túnel: confirma a qué base llega antes de correr nada contra ella)' : ''}`);
  }
  return pending ? 1 : 0;
}

function probe(dir) {
  const project = requireProject(dir);
  let bad = 0;
  for (const ws of project.workspaces.filter((w) => w.adoptable)) {
    const r = tb.probeTests(ws);
    if (r.error) bad++;
    console.log(`${ws.name}: ${r.ok ? `ok · ${r.ok}` : r.skip ? `sin prueba · ${r.skip}` : `FALTA · ${r.error}`}`);
  }
  return bad ? 1 : 0;
}

function baseline(dir, names, write) {
  const project = requireProject(dir);
  let pending = 0;
  for (const ws of project.workspaces.filter((w) => w.adoptable && w.commands.test && w.specPattern && (!names.length || names.includes(w.name)))) {
    const b = tb.readBaseline(ws);
    const file = rel(ws.dir, b.file);
    const committed = b.data && git(ws.dir, ['ls-files', '--error-unmatch', '--', file]).status === 0;
    if (committed) {
      console.log(`${ws.name}: ${file} commiteada`);
      continue;
    }
    if (b.data) {
      console.log(`${ws.name}: ${file} existe sin commitear; commitéala tú con gates: en el asunto`);
      pending++;
      continue;
    }
    if (!write) {
      console.log(`${ws.name}: falta ${file}; la capturaría (setup.js baseline --ws ${ws.name} --write)`);
      pending++;
      continue;
    }
    if (adopt.baseline(project, ws.name, true) !== 0) pending++;
  }
  return pending ? 1 : 0;
}

function graph(dir, write) {
  const c = requireComposition(dir);
  const v = sh('graphify --version', dir);
  if (v.status !== 0) {
    console.log(`graphify no está instalado: sigue sin grafo. Para tenerlo, instálalo con la guía de ${GRAPHIFY} y vuelve a correr este paso`);
    return 0;
  }
  const targets = c.repos.map((e) => path.resolve(dir, e.path)).filter(isRepo);
  const out = path.join(dir, 'graphify-out', 'graph.json');
  if (!write) {
    console.log(`${firstLine(v.out) || 'graphify'}: extraería el grafo de ${targets.map((t) => rel(dir, t)).join(', ')} (graphify update) y lo mergearía en ${rel(dir, out)}`);
    return 0;
  }
  const env = { ...process.env, GRAPHIFY_BACKEND: 'none' };
  const graphs = [];
  for (const t of targets) {
    const r = sh(`graphify update ${quote(t)}`, dir, env);
    const g = path.join(t, 'graphify-out', 'graph.json');
    if (r.status !== 0 || !fs.existsSync(g)) {
      console.log(`${rel(dir, t)}: graphify update falló: ${firstLine(r.out)}`);
      return 1;
    }
    graphs.push(g);
    console.log(`${rel(dir, t)}: grafo en ${rel(dir, g)}`);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const m = sh(`graphify merge-graphs ${graphs.map(quote).join(' ')} --out ${quote(out)}`, dir, env);
  if (m.status !== 0) {
    console.log(`graphify merge-graphs falló: ${firstLine(m.out)}`);
    return 1;
  }
  console.log(`grafo de la carpeta en ${rel(dir, out)}`);
  return 0;
}

function close(dir) {
  const c = requireComposition(dir);
  const project = requireProject(dir);
  const check = spawnSync(process.execPath, [path.join(__dirname, 'adoption-check.js')], { cwd: dir, encoding: 'utf8' });
  process.stdout.write(check.stdout || '');
  const mine = [];
  for (const e of envState(dir, c)) {
    if (!e.hasEnv) mine.push(`${e.path}: crear .env (setup.js env --write lo copia de .env.example)`);
    if (e.empty.length) mine.push(`${e.path}: llenar en .env ${e.empty.join(', ')}`);
  }
  for (const ws of project.workspaces) {
    const db = (ws.forbidden || []).filter(touchesDatabase);
    if (db.length) mine.push(`${ws.name}: los comandos contra la base los corres tú, sabiendo a qué base apunta el .env: ${db.join(', ')}`);
  }
  for (const entry of c.repos) {
    const target = path.resolve(dir, entry.path);
    const want = isRepo(target) && (entry.branch || defaultOf(target));
    if (want && branchOf(target) !== want) mine.push(`${entry.path}: está en ${branchOf(target)} y la composición dice ${want}`);
  }
  mine.push('los permisos de la app que pida el issue (por ejemplo, en el mantenedor de roles): los da una persona con acceso');
  console.log('\npendiente tuyo:');
  for (const m of mine) console.log(`  - ${m}`);
  return check.status === 0 ? 0 : 1;
}

module.exports = { parseEnv, dbHosts, installIn };

function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        dir: { type: 'string' }, switch: { type: 'string', multiple: true }, repo: { type: 'string', multiple: true }, ws: { type: 'string', multiple: true },
        write: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    die(`setup: ${e.message}`);
  }
  const o = args.values;
  if (o.help) help(__filename);
  const [step, ...rest] = args.positionals;
  const STEPS = ['clone', 'repos', 'deps', 'env', 'probe', 'baseline', 'graph', 'claude-md', 'permissions', 'close'];
  const usage = `uso: setup.js <paso> [--dir carpeta] [--write]; pasos: ${STEPS.join(', ')} (clone [<url o ruta> [destino]])`;
  if (!STEPS.includes(step) || (step === 'clone' ? rest.length > 2 || o.dir : rest.length)) die(usage);
  if ((o.switch && step !== 'repos') || (o.repo && step !== 'deps') || (o.ws && step !== 'baseline') || (o.write && ['probe', 'close'].includes(step))) die(usage);
  const dir = path.resolve(o.dir || '.');
  const run = {
    clone: () => clone(rest[0], rest[1], o.write),
    repos: () => repos(dir, o.switch || [], o.write),
    deps: () => deps(dir, o.repo || [], o.write),
    env: () => envStep(dir, o.write),
    probe: () => probe(dir),
    baseline: () => baseline(dir, o.ws || [], o.write),
    graph: () => graph(dir, o.write),
    'claude-md': () => adopt.claudeMd(requireProject(dir), o.write),
    permissions: () => adopt.permissions(requireProject(dir), o.write),
    close: () => close(dir),
  };
  process.exit(run[step]());
}

if (require.main === module) main();
