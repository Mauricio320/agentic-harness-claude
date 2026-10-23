'use strict';
// Reporter de node --test para test-baseline.js (docs/PLAN.md §6.1). Junta los eventos del runner y
// al final escribe el contrato de resultados ($defs.testResultContract) en su destino: cada test con
// su archivo absoluto, su nombre completo (los describe y el test con › entre medio) y su estado. Los
// suites no cuentan como test; un archivo que no llega a correr sale como "Test suite failed to run",
// como en jest. El resumen sale de los conteos del propio runner, para que test-baseline compruebe
// que el detalle cuadra. test-baseline lo pasa por URL, antes de los archivos, junto al reporter spec
// por stdout.

const path = require('path');

const SUITE_FAILED = 'Test suite failed to run';
const slash = (p) => String(p).replace(/\\/g, '/');

function contractOf(events, cwd = process.cwd()) {
  const stacks = new Map();
  const tests = [];
  let counts = null;
  for (const { type, data = {} } of events) {
    const file = data.file || '';
    if (type === 'test:start') {
      const stack = (stacks.get(file) || []).slice(0, data.nesting);
      stack[data.nesting] = data.name;
      stacks.set(file, stack);
    } else if ((type === 'test:pass' || type === 'test:fail') && (data.details || {}).type !== 'suite') {
      const whole = file && slash(path.resolve(cwd, String(data.name))) === slash(path.resolve(file));
      if (whole && type === 'test:pass') continue;
      const name = whole ? SUITE_FAILED : [...(stacks.get(file) || []).slice(0, data.nesting), data.name].join(' › ');
      const status = data.skip || data.todo ? 'saltado' : type === 'test:pass' ? 'pasa' : 'falla';
      tests.push({ file, name, status });
    } else if (type === 'test:summary' && !data.file) counts = data.counts;
  }
  const c = counts || {};
  const pasa = Number(c.passed || 0);
  const falla = Number(c.failed || 0) + Number(c.cancelled || 0);
  const saltado = Number(c.skipped || 0) + Number(c.todo || 0);
  return { tests, summary: { pasa, falla, saltado, total: counts ? Number(c.tests || 0) : pasa + falla + saltado } };
}

async function* reporter(source) {
  const events = [];
  for await (const { type, data } of source) {
    if (!['test:start', 'test:pass', 'test:fail', 'test:summary'].includes(type)) continue;
    const { name, nesting, file, skip, todo, details, counts } = data || {};
    events.push({ type, data: { name, nesting, file, skip, todo, details: details && { type: details.type }, counts } });
  }
  yield `${JSON.stringify(contractOf(events))}\n`;
}

module.exports = reporter;
module.exports.contractOf = contractOf;
module.exports.SUITE_FAILED = SUITE_FAILED;
