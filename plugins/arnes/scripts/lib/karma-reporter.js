'use strict';
// Reporter de Karma del arnés (docs/PLAN.md §6.1), en Node y sin dependencias. Lo carga la
// configuración temporal que arma lib/karma-config.js. Escribe una línea JSON por evento, en el
// momento, en el archivo de config.arnes.outputFile: así una corrida que se aborta a la mitad deja lo
// que alcanzó a correr. Las líneas:
//   { tipo: "inicio" }                                   al empezar la corrida
//   { tipo: "spec", suite: [describe...], nombre, estado: pasa | falla | saltado, log: [..], total }
//                                                        al terminar cada test; total es el que declaró
//                                                        jasmine para la corrida, si ya lo dijo
//   { tipo: "error", error }                             un error del navegador (un script que no carga,
//                                                        una excepción fuera de un test)
//   { tipo: "fin", pasa, falla, saltado, total, error, desconectado }
//                                                        al cerrar la corrida, con los contadores de Karma;
//                                                        error o desconectado dicen que no terminó entera
// No escribe nada en la salida de Karma: los demás reporters de la configuración siguen igual.

const fs = require('fs');

function ArnesReporter(config) {
  const file = (config.arnes || {}).outputFile;
  const write = (event) => {
    if (file) fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  };
  const totalOf = (browser) => (browser && browser.lastResult && Number(browser.lastResult.total)) || undefined;
  this.adapters = [];
  this.onRunStart = () => write({ tipo: 'inicio' });
  this.onSpecComplete = (browser, r) => {
    const estado = r.skipped || r.pending ? 'saltado' : r.success ? 'pasa' : 'falla';
    write({ tipo: 'spec', suite: [].concat(r.suite || []), nombre: String(r.description || ''), estado, log: estado === 'falla' ? [].concat(r.log || []).map(String) : [], total: totalOf(browser) });
  };
  this.onBrowserError = (browser, error) => write({ tipo: 'error', error: typeof error === 'string' ? error : (error && (error.message || JSON.stringify(error))) || String(error) });
  this.onRunComplete = (browsers, results) => {
    const c = { pasa: 0, falla: 0, saltado: 0, total: 0 };
    const each = browsers && typeof browsers.forEach === 'function' ? browsers : [];
    each.forEach((b) => {
      const l = b.lastResult || {};
      c.pasa += Number(l.success) || 0;
      c.falla += Number(l.failed) || 0;
      c.saltado += Number(l.skipped) || 0;
      c.total += Number(l.total) || 0;
    });
    write({ tipo: 'fin', ...c, error: Boolean(results && results.error), desconectado: Boolean(results && results.disconnected) });
  };
}
ArnesReporter.$inject = ['config'];

module.exports = { 'reporter:arnes': ['type', ArnesReporter] };
