'use strict';
// La huella de lo tocado de un workspace (docs/PLAN.md §6.1): el HEAD del repo, el sha256 de la lista
// ordenada de tocados respecto del base y el sha256 de "ruta\0sha256 del contenido" de cada uno,
// trackeado o no. La comparan la bandera de verificación (gate-flag.js), la marca de la revisión
// (review.js) y la última corrida de ci-gate. touched() con el proyecto excluye .tmp/harness/: si no,
// escribir la bandera dentro del workspace cambiaría la lista de tocados y la vencería al instante.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { git, firstLine } = require('./exec.js');
const { touched } = require('../touched-files.js');

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');

function stateOf(project, ws, base = 'HEAD') {
  const head = git(ws.gitRoot, ['rev-parse', 'HEAD']);
  if (head.status !== 0) return { error: `git rev-parse HEAD falló en ${ws.name}: ${firstLine(head.stderr)}` };
  const t = touched(ws, base, project);
  if (t.error) return { error: t.error };
  const file = (f) => path.join(ws.dir, f);
  const touchedHash = sha(t.files.join('\n'));
  const contentHash = sha(t.files.map((f) => `${f}\0${fs.existsSync(file(f)) ? sha(fs.readFileSync(file(f))) : '-'}`).join('\n'));
  return { head: head.stdout.trim(), touchedHash, contentHash, files: t.files };
}

module.exports = { stateOf };
