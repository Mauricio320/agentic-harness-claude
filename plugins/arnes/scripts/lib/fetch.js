'use strict';
// Un git fetch de origin por repo cada dos minutos (docs/PLAN.md §7). Al planear y al entrar a un
// worktree corren seguidos behind, check y materialize, y cada uno hacía su fetch: un viaje a la red
// por repo y por script. La marca del último fetch que salió bien va en el directorio común del repo
// (.git/arnes-fetch.json), así que la comparten el checkout principal y todos sus worktrees.

const fs = require('fs');
const path = require('path');
const { git } = require('./exec.js');

const MAX_AGE_MS = 2 * 60 * 1000;

function markOf(repo) {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim();
  return common ? path.join(common, 'arnes-fetch.json') : null;
}

// git fetch --quiet origin, salvo que el repo haya traído origin hace menos de maxAgeMs.
// → { status, stderr, cached }
function fetchOrigin(repo, { maxAgeMs = MAX_AGE_MS, now = Date.now() } = {}) {
  const mark = markOf(repo);
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(mark, 'utf8')).at);
    if (now - at >= 0 && now - at < maxAgeMs) return { status: 0, stderr: '', cached: true };
  } catch {
    /* sin marca: toca traer */
  }
  const r = git(repo, ['fetch', '--quiet', 'origin']);
  if (r.status === 0 && mark) {
    try {
      fs.writeFileSync(mark, JSON.stringify({ at: new Date(now).toISOString() }) + '\n');
    } catch {
      /* sin marca, el próximo vuelve a traer */
    }
  }
  return { ...r, cached: false };
}

module.exports = { MAX_AGE_MS, fetchOrigin, markOf };
