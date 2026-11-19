'use strict';
// La configuración de un proyecto del arnés (docs/PLAN.md §6.2): bajo un .claude/, el harness.json
// (riskPaths, forbidden, codeGlobs), settings.json y settings.local.json (permisos y hooks de Claude
// Code), rules/ (las reglas duras que cita el reviewer) y hooks/. Son las reglas que el arnés le aplica
// al modelo: fuera de init, setup o un ajuste aprobado por la persona en curso (AJUSTE dice cómo
// proponerlo, ajuste.js), el modelo no las cambia, ni con Edit o Write
// (plan-guard), ni por el shell ni en un commit (guard). Fuera de un proyecto del arnés no se juzga.

const fs = require('fs');
const path = require('path');
const { git } = require('./exec.js');
const { loadProject, MANIFEST } = require('./manifest.js');
const { read, prepOpen } = require('./timeline.js');
const { projectFor } = require('../worktree-ledger.js');

const CONFIG = /(^|[\\/])\.claude[\\/](harness\.json|settings(\.local)?\.json|rules|hooks)([\\/]|$)/i;
// Lo mismo como pathspecs de git, relativas a la raíz del repo.
const AJUSTE_JS = path.resolve(__dirname, '..', 'ajuste.js').split(path.sep).join('/');
const AJUSTE = `Copiarla del checkout principal a un worktree no hace falta: el arnés la lleva solo. Si lo que hace falta es cambiarla, propónselo: corre node "${AJUSTE_JS}" propone --archivo <ruta> --detalle "<qué cambia y por qué>", díselo a la persona en una o dos frases y termina el turno. Si responde que sí, node "${AJUSTE_JS}" aprueba abre la configuración solo ese turno. Ella también puede escribir /arnes:init --ajustar.`;
const CONFIG_SPEC = ['.claude/harness.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/rules', '.claude/hooks'];

// La carpeta que tiene el .claude/ de esa configuración, o null si la ruta no es configuración.
function configRoot(abs) {
  const m = CONFIG.exec(abs);
  return m ? abs.slice(0, m.index) || '.' : null;
}

// El proyecto del arnés al que pertenece esa carpeta (el de la carpeta, si el repo está en una),
// aunque su manifiesto tenga errores; null si no hay ninguno.
function configProject(root) {
  return projectFor(root) || loadProject(root);
}

// true si init o setup están en curso en la timeline de esa raíz de proyecto.
const prepAt = (root) => Boolean(prepOpen(read(root)));

// La raíz cuya timeline decide sobre esa configuración: la del proyecto, o la del repo cuyo manifiesto
// falta del árbol (si no, recrearlo distinto pasaría); null si no es de ningún proyecto del arnés.
function configHome(root) {
  const project = configProject(root);
  return project ? project.root : missingManifest(root);
}

// El primer directorio que existe subiendo desde dir.
function existing(dir) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  return d;
}

// La raíz del repo cuyo HEAD trae un .claude/harness.json que ya no está en el árbol, o null. Sin el
// archivo, loadProject no encuentra el proyecto y los guards se apagan: esto lo nota igual. Si la
// persona lo quita a propósito, commitea el borrado y deja de contar.
function missingManifest(dir) {
  const top = git(existing(dir), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) return null;
  const root = path.resolve(top.stdout.trim());
  if (fs.existsSync(path.join(root, MANIFEST))) return null;
  return git(root, ['cat-file', '-e', `HEAD:${MANIFEST.split(path.sep).join('/')}`]).status === 0 ? root : null;
}

module.exports = { AJUSTE, AJUSTE_JS, CONFIG_SPEC, configRoot, configProject, configHome, prepAt, missingManifest };
