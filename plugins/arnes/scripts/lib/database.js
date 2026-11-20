'use strict';
// Comandos que tocan una base (docs/PLAN.md §8). Los corre la persona desde su terminal, sabiendo
// contra qué base apunta el .env: un proxy en 127.0.0.1 puede ser QA. init-draft los propone en
// forbidden, adoption-check comprueba que estén, y el guard los niega con su propio motivo. La única
// excepción es afterBuild con onlyIfLocalDb: build los corre, y el guard los deja pasar, solo cuando
// la base del .env del workspace es la local del patrón (localDb).

const fs = require('fs');
const path = require('path');

// Un script del package.json toca una base si su nombre lo dice: corre migraciones (migrate,
// migration:run, migrar), sincroniza o borra el esquema (sync, schema, drop, fresh, reset) o la
// consulta (query); o si su comando abre un cliente de la base.
const SCRIPT_NAME = /(sync|migrat|migrar|migrac|push|deploy|seed|reset|schema|drop|fresh|query)/i;
const DB_CLI = /(^|[\s"'`&;|])(psql|mysql|mariadb|sqlcmd|mongosh|mongo|sqlite3|redis-cli)(?=$|\s)/;

// Los subcomandos de prisma, typeorm y knex que escriben. Los que solo leen (prisma migrate status,
// knex migrate:status) quedan fuera.
const TOOLS = {
  prisma: ['prisma migrate dev', 'prisma migrate deploy', 'prisma migrate reset', 'prisma migrate resolve', 'prisma db push', 'prisma db seed', 'prisma db execute'],
  typeorm: ['typeorm migration:run', 'typeorm migration:revert', 'typeorm schema:sync', 'typeorm schema:drop', 'typeorm query'],
  knex: ['knex migrate:latest', 'knex migrate:up', 'knex migrate:down', 'knex migrate:rollback', 'knex seed:run'],
};
const WRITES = new RegExp(`(^|[\\s"'\`&;|])(${Object.values(TOOLS).flat().map((c) => c.replace(/ /g, '\\s+')).join('|')})(?=$|[\\s"'\`&;|])`);
const RUN = /^\s*(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([^\s]+)/;

// Un script como se teclea con el gestor del repo: npm run x, pnpm x, yarn x.
const typed = (pm, name) => (pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`);

// El texto de un comando o de una entrada de forbidden: un script que se llama como una escritura,
// o una herramienta que escribe.
function touchesDatabase(cmd) {
  const run = cmd.match(RUN);
  return Boolean((run && SCRIPT_NAME.test(run[1])) || WRITES.test(cmd));
}

// Lo que va en forbidden para un repo: los scripts que tocan una base, por su nombre, porque su
// comando corre una escritura de prisma, typeorm o knex, o porque abre un cliente de la base, como se
// teclean con `pm`, el gestor del repo; y las escrituras de la CLI de esas herramientas si están en
// las dependencias, por si se invocan directo.
function databaseForbidden(pkg, pm = 'npm') {
  const out = [];
  for (const [name, body] of Object.entries((pkg && pkg.scripts) || {})) {
    if (SCRIPT_NAME.test(name) || WRITES.test(String(body)) || DB_CLI.test(String(body))) out.push(typed(pm, name));
  }
  const deps = { ...(pkg && pkg.dependencies), ...(pkg && pkg.devDependencies) };
  if (deps.prisma || deps['@prisma/client']) out.push(...TOOLS.prisma);
  if (deps.typeorm) out.push(...TOOLS.typeorm);
  if (deps.knex) out.push(...TOOLS.knex);
  return out;
}

// Las entradas de databaseForbidden que faltan en `forbidden`. Un script cuenta como cubierto si
// alguna entrada lo corre con cualquier gestor; una herramienta, si está tal cual o con npx delante.
function missingFromForbidden(expected, forbidden = []) {
  const have = forbidden.map((f) => f.trim().replace(/^npx\s+/, ''));
  return expected.filter((e) => {
    const run = e.match(RUN);
    if (run) return !have.some((f) => (f.match(RUN) || [])[1] === run[1]);
    return !have.includes(e);
  });
}

// Las variables de un .env: [{ key, value }], sin comentarios ni export.
function parseEnv(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value: v });
  }
  return out;
}

const DB_URL = /^(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|sqlserver|mssql):\/\//i;
// El nombre de una variable de conexión a una base: DB_HOST, DATABASE_URL, MYSQL_PORT, REDIS_HOST…
const DB_VAR = /(database|postgres|mysql|mariadb|mongo|redis|(^|_)db(_|$)|(^|_)pg(_|$))/i;
const DEFAULT_PORT = { mysql: 3306, mariadb: 3306, postgres: 5432, postgresql: 5432, sqlserver: 1433, mssql: 1433 };

// El host y el puerto de una conexión, sin usuario, contraseña ni base; null si no se leen.
function hostOf(value) {
  try {
    const u = new URL(value);
    if (u.hostname) return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    /* una contraseña con caracteres raros rompe URL: se lee a mano */
  }
  const m = String(value).match(/@([^/:@?]+)(?::(\d+))?(?:[/?]|$)/);
  return m ? (m[2] ? `${m[1]}:${m[2]}` : m[1]) : null;
}

// La condición onlyIfLocalDb de afterBuild (docs/PLAN.md §8): el valor de `env` en el .env del
// workspace coincide con `pattern`. Nunca devuelve el valor, solo el host y el puerto que vio.
// → { ok, host?, why? }
function localDb(ws) {
  const cond = ws.afterBuild && ws.afterBuild.onlyIfLocalDb;
  if (!cond) return { ok: false, why: 'afterBuild no declara onlyIfLocalDb' };
  const file = path.join(ws.dir, '.env');
  if (!fs.existsSync(file)) return { ok: false, why: `no hay .env en ${ws.dir}` };
  const v = parseEnv(fs.readFileSync(file, 'utf8')).find((x) => x.key === cond.env);
  if (!v || !v.value) return { ok: false, why: `${cond.env} no tiene valor en el .env` };
  let re;
  try {
    re = new RegExp(cond.pattern);
  } catch {
    return { ok: false, why: `el pattern de onlyIfLocalDb no es una expresión válida` };
  }
  const host = hostOf(v.value);
  if (re.test(v.value)) return { ok: true, host };
  return { ok: false, host, why: `${cond.env} apunta a ${host || 'un host que no se lee'}, que no es la base local del patrón` };
}

// Las bases que no son locales en los .env de un workspace (files, de lib/puertos.js envFiles): su host,
// su puerto y su nombre, nunca credenciales. Local es localhost, 127.0.0.1, ::1 o host.docker.internal; con
// onlyIfLocalDb declarado, también un host local que no cumple su patrón (un proxy a QA en 127.0.0.1).
// El puerto y el nombre son lo que distingue una base de otra en el mismo host: el 2026-11-19 el aviso
// decía solo «100.64.87.88», la persona creyó que era QA (el 5455) y la app arrancó contra producción (el
// 5432). Con el host en una variable suelta (DB_HOST), salen de sus hermanas (DB_PORT, DB_NAME).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)(:\d+)?$/i;
const named = (target, name) => (name ? `${target} (base ${name})` : target);
function remoteDbs(ws, files) {
  const out = new Set();
  for (const name of files) {
    const vars = parseEnv(fs.readFileSync(path.join(ws.dir, name), 'utf8'));
    const sister = (key, ...ends) => ends.map((end) => vars.find((x) => x.key.toLowerCase() === key.replace(/HOST$/i, end).toLowerCase())).filter((x) => x && x.value).map((x) => x.value)[0];
    for (const { key, value } of vars) {
      const url = DB_URL.test(value);
      const host = url ? hostOf(value) : DB_VAR.test(key) && /HOST$/i.test(key) ? value : null;
      if (!host || LOCAL_HOST.test(host)) continue;
      if (url) out.add(named(host, (value.match(/@[^/@?]+\/([^/?#]+)/) || [])[1]));
      else out.add(named([host, sister(key, 'PORT')].filter(Boolean).join(':'), sister(key, 'NAME', 'DATABASE', 'DB')));
    }
  }
  const proxy = ws.afterBuild && ws.afterBuild.onlyIfLocalDb ? localDb(ws) : { ok: true };
  if (!proxy.ok && proxy.host) out.add(proxy.host);
  return [...out];
}

// Lo que init-draft propone para un repo con scripts de sync (docs/PLAN.md §8): el build y los sync,
// solo con la base del .env local. La variable sale de la primera conexión de .env.example (o
// DATABASE_URL), y el puerto del patrón, de su url o del puerto por defecto de su motor.
function afterBuildDraft(pkg, pm, example) {
  const syncs = Object.keys((pkg && pkg.scripts) || {}).filter((k) => /sync/i.test(k));
  if (!syncs.length) return null;
  const vars = example ? parseEnv(example) : [];
  const conn = vars.find((x) => DB_URL.test(x.value));
  const scheme = conn ? conn.value.match(DB_URL)[1].toLowerCase() : null;
  const port = (conn && (hostOf(conn.value) || '').split(':')[1]) || DEFAULT_PORT[scheme];
  return {
    commands: [...(pkg.scripts.build ? [`${pm} run build`] : []), ...syncs.map((k) => `${pm} run ${k}`)],
    onlyIfLocalDb: { env: conn ? conn.key : 'DATABASE_URL', pattern: `@(localhost|127\\.0\\.0\\.1):${port || '\\d+'}/` },
  };
}

module.exports = { typed, SCRIPT_NAME, TOOLS, DB_URL, DB_VAR, touchesDatabase, databaseForbidden, missingFromForbidden, parseEnv, hostOf, localDb, remoteDbs, afterBuildDraft };
