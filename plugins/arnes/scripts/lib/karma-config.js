'use strict';
// Karma de serie (docs/PLAN.md §6.1): el target de test de Angular de un workspace y la configuración
// temporal con que test-baseline lo corre, sin que la persona escriba nada en su repo.
//   karmaTarget(dir)   el proyecto de angular.json cuyo test usa un builder de Karma
//                      (@angular-devkit/build-angular:karma o @angular/build:karma), con su
//                      karmaConfig y si construye con webpack (el builderMode por defecto, "browser",
//                      del builder de devkit); null si no hay
//   karmaSetup(ws, root)
//                      escribe <root>/.tmp/harness/karma/<ws>.conf.js y devuelve su ruta. Si el target
//                      declara karmaConfig, la temporal la carga y le agrega el reporter; si no, arma
//                      la de serie del builder: frameworks jasmine (y @angular-devkit/build-angular con
//                      webpack), karma-jasmine, karma-chrome-launcher, karma-coverage si está y el
//                      plugin de devkit con webpack, resueltos desde el node_modules del workspace. En
//                      los dos casos, el reporter de lib/karma-reporter.js con su archivo en la
//                      variable ARNES_KARMA_RESULTADOS, Chrome sin cabeza, una sola corrida y nunca watch.
//   karmaTsconfig(ws, root, specs, n)
//                      el tsconfig temporal del gate, <root>/.tmp/harness/karma/<ws>.tsconfig[-n].json,
//                      que test-baseline pasa con --ts-config: extiende el tsConfig del target de test
//                      (ruta absoluta), compila solo los specs dados y los src/**/*.d.ts de su carpeta,
//                      conserva sus types con jasmine y apunta typeRoots al node_modules/@types del
//                      workspace, porque el archivo vive fuera de él y sin eso no encuentra it ni
//                      describe. Así un spec roto que nadie tocó no tumba la corrida de los tocados: el
//                      builder de devkit con webpack revisa los tipos de todo el programa del tsconfig.
//                      null si el target no declara tsConfig
// Lo demás (basePath, files, el bundle de los specs) lo pone el builder de Angular, que pisa esas
// opciones de la configuración.

const fs = require('fs');
const path = require('path');

const BUILDERS = ['@angular-devkit/build-angular:karma', '@angular/build:karma'];
const DEVKIT = '@angular-devkit/build-angular:karma';
const ESBUILD = ['@angular/build:application', '@angular-devkit/build-angular:application', '@angular-devkit/build-angular:browser-esbuild'];

function karmaTarget(dir) {
  let ng;
  try {
    ng = JSON.parse(fs.readFileSync(path.join(dir, 'angular.json'), 'utf8'));
  } catch {
    return null;
  }
  for (const [project, p] of Object.entries((ng && ng.projects) || {})) {
    const arch = (p && (p.architect || p.targets)) || {};
    const test = arch.test || {};
    if (!BUILDERS.includes(test.builder)) continue;
    const options = test.options || {};
    const mode = options.builderMode || 'browser';
    const build = (arch.build || {}).builder;
    const webpack = test.builder === DEVKIT && (mode === 'browser' || (mode === 'detect' && !ESBUILD.includes(build)));
    return { project, builder: test.builder, karmaConfig: options.karmaConfig ? path.resolve(dir, options.karmaConfig) : null, tsConfig: options.tsConfig ? path.resolve(dir, options.tsConfig) : null, webpack, root: path.resolve(dir, p.root || '') };
  }
  return null;
}

function karmaSetup(ws, root) {
  const target = karmaTarget(ws.dir);
  const dir = path.join(root, '.tmp', 'harness', 'karma');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ws.name}.conf.js`);
  const js = (p) => JSON.stringify(p.replace(/\\/g, '/'));
  const builtIn = [
    `  config.set({`,
    `    frameworks: ${JSON.stringify(target && target.webpack ? ['jasmine', '@angular-devkit/build-angular'] : ['jasmine'])},`,
    `    plugins: [desde('karma-jasmine'), desde('karma-chrome-launcher'), opcional('karma-coverage')${target && target.webpack ? `, desde('@angular-devkit/build-angular/plugins/karma')` : ''}].filter(Boolean),`,
    `    client: { jasmine: {}, clearContext: true },`,
    `    customLaunchers: { ChromeHeadlessNoSandbox: { base: 'ChromeHeadless', flags: ['--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage'] } },`,
    `  });`,
  ];
  const own = target && target.karmaConfig;
  const body = [
    `'use strict';`,
    `const { createRequire } = require('module');`,
    `const desde = createRequire(${js(path.join(ws.dir, 'package.json'))});`,
    `const opcional = (nombre) => { try { return desde(nombre); } catch { return null; } };`,
    `const arnes = require(${js(path.join(__dirname, 'karma-reporter.js'))});`,
    `module.exports = function (config) {`,
    ...(own ? [`  const propia = require(${js(own)});`, `  if (typeof propia === 'function') propia(config);`, `  else config.set(propia);`] : builtIn),
    `  config.set({`,
    `    plugins: [...(config.plugins || ['karma-*']), arnes],`,
    `    reporters: [...(config.reporters || ['progress']).filter((r) => r !== 'arnes'), 'arnes'],`,
    `    arnes: { outputFile: process.env.ARNES_KARMA_RESULTADOS },`,
    `    browsers: ['ChromeHeadless'],`,
    `    singleRun: true,`,
    `    autoWatch: false,`,
    `    restartOnFileChange: false,`,
    `  });`,
    `};`,
    ``,
  ];
  fs.writeFileSync(file, body.join('\n'));
  return file;
}

function typesOf(tsconfig) {
  try {
    const text = fs.readFileSync(tsconfig, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const types = (JSON.parse(text).compilerOptions || {}).types;
    return Array.isArray(types) ? types : [];
  } catch {
    return [];
  }
}

function karmaTsconfig(ws, root, specs, n = 0) {
  const target = karmaTarget(ws.dir);
  if (!target || !target.tsConfig) return null;
  const posix = (p) => p.replace(/\\/g, '/');
  const file = path.join(root, '.tmp', 'harness', 'karma', `${ws.name}.tsconfig${n ? `-${n}` : ''}.json`);
  const data = {
    extends: posix(target.tsConfig),
    compilerOptions: { types: [...new Set([...typesOf(target.tsConfig), 'jasmine'])], typeRoots: [posix(path.join(ws.dir, 'node_modules', '@types'))] },
    files: specs.map((s) => posix(path.resolve(ws.dir, s))),
    include: [posix(path.join(path.dirname(target.tsConfig), 'src', '**', '*.d.ts'))],
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

module.exports = { karmaTarget, karmaSetup, karmaTsconfig };
