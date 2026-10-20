'use strict';
// Comandos que tocan una base (docs/PLAN.md §8). Los corre la persona desde su terminal, sabiendo
// contra qué base apunta el .env: un proxy en 127.0.0.1 puede ser QA. init-draft los propone en
// forbidden, adoption-check comprueba que estén, y el guard los niega con su propio motivo.

// Un script del package.json toca una base si su nombre lo dice.
const SCRIPT_NAME = /(sync|migrate|migrar|push|deploy|seed|reset)/i;

// Los subcomandos de prisma, typeorm y knex que escriben. Los que solo leen (prisma migrate status,
// knex migrate:status) quedan fuera.
const TOOLS = {
  prisma: ['prisma migrate dev', 'prisma migrate deploy', 'prisma migrate reset', 'prisma migrate resolve', 'prisma db push', 'prisma db seed', 'prisma db execute'],
  typeorm: ['typeorm migration:run', 'typeorm migration:revert', 'typeorm schema:sync', 'typeorm schema:drop', 'typeorm query'],
  knex: ['knex migrate:latest', 'knex migrate:up', 'knex migrate:down', 'knex migrate:rollback', 'knex seed:run'],
};
const WRITES = new RegExp(`(^|[\\s"'\`&;|])(${Object.values(TOOLS).flat().map((c) => c.replace(/ /g, '\\s+')).join('|')})(?=$|[\\s"'\`&;|])`);
const RUN = /^\s*(?:npm|pnpm|yarn)\s+(?:run(?:-script)?\s+)?([^\s]+)/;

// El texto de un comando o de una entrada de forbidden: un script que se llama como una escritura,
// o una herramienta que escribe.
function touchesDatabase(cmd) {
  const run = cmd.match(RUN);
  return Boolean((run && SCRIPT_NAME.test(run[1])) || WRITES.test(cmd));
}

// Lo que va en forbidden para un repo: los scripts que tocan una base, por su nombre o porque su
// comando corre una escritura de prisma, typeorm o knex, y esas escrituras si la herramienta está en
// las dependencias. `pm` es el gestor con que se corren los scripts.
function databaseForbidden(pkg, pm = 'npm') {
  const out = [];
  for (const [name, body] of Object.entries((pkg && pkg.scripts) || {})) {
    if (SCRIPT_NAME.test(name) || WRITES.test(String(body))) out.push(`${pm} run ${name}`);
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

module.exports = { SCRIPT_NAME, TOOLS, touchesDatabase, databaseForbidden, missingFromForbidden };
