'use strict';
// Casos portados del git-guard de renova365 harness-tests.js, sobre la bandera del arnés en vez
// del marcador de gate de renova, más los del parser por segmentos. No se portan los casos de
// diff_hash por contenido (docs/PLAN.md §11: sin huella del árbol) ni los estados sin-gate y
// bloqueado-aprobado-por-humano, que eran propios de renova.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { segments, command } = require('../scripts/lib/shell.js');
const h = require('./helpers.js');

function folder() {
  const root = h.tmp('guard');
  const ws = (name, forbidden) =>
    h.repoManifest(name, h.workspace({ name, forbidden, commands: { typecheck: ['tsc --noEmit'] } }));
  const api = path.join(root, 'api');
  const client = path.join(root, 'client');
  h.repo(api, {
    '.gitignore': '.claude/worktrees/\n',
    '.claude/harness.json': ws('api', ['npm run lint', 'npm run format']),
    'src/a.ts': 'a\n',
    'README.md': 'x\n',
  });
  h.repo(client, { '.claude/harness.json': ws('client', ['npm run lint', 'ng lint']), 'src/b.ts': 'b\n' });
  h.write(root, '.claude/harness.json', h.manifestJson({ version: 1, name: 'carpeta', repos: [{ path: 'api' }, { path: 'client' }] }));
  return { root, api, client };
}

const guard = (cwd, command, opts = {}) =>
  h.hook('guard', { hook_event_name: 'PreToolUse', tool_name: opts.tool || 'Bash', cwd, tool_input: { command } }, { env: opts.env });
const denied = (r) => Boolean(r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.permissionDecision === 'deny');
const reason = (r) => (denied(r) ? r.out.hookSpecificOutput.permissionDecisionReason : '');
const flag = (cwd, ws, result = 'pass') => assert.equal(h.run('gate-flag.js', ['write', ws, '--result', result], { cwd }).status, 0);

// ---------- parser ----------

test('segments: separa por && || ; | & y saltos, respeta comillas y redirecciones', () => {
  assert.deepEqual(segments('a && b || c; d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(segments('echo "a && b; c" | grep x'), ['echo "a && b; c"', 'grep x']);
  assert.deepEqual(segments('npm test 2>&1 | tail -5'), ['npm test 2>&1', 'tail -5']);
  assert.deepEqual(segments('make &> log.txt'), ['make &> log.txt']);
});

test('segments: el cuerpo de un heredoc y de un here-string de PowerShell no es comando', () => {
  const heredoc = "cat > nota.md <<'EOF'\ngit commit -m x\ngit reset --hard\nEOF\ngit status";
  assert.deepEqual(segments(heredoc), ['cat > nota.md <<HEREDOC', 'git status']);
  assert.deepEqual(segments('cat <<-FIN\n\tgit push -f\n\tFIN\necho ok'), ['cat <<HEREDOC', 'echo ok']);
  const ps = "$m = @'\ngit reset --hard\n'@\nWrite-Output $m";
  assert.deepEqual(segments(ps), ["$m = ''", 'Write-Output $m']);
});

test('command: salta asignaciones de entorno, envoltorios y paréntesis de subshell', () => {
  assert.equal(command('FOO=1 BAR=2 git status').exe, 'git');
  assert.equal(command('sudo env X=1 npm run lint').exe, 'npm');
  assert.equal(command('(cd api').exe, 'cd');
  assert.equal(command('"C:\\Program Files\\Git\\bin\\git.exe" status').exe, 'git');
  assert.equal(command('& git.exe status').exe, 'git');
});

// ---------- portados de renova ----------

test('guard permite comandos sin git y git inofensivo', () => {
  const { api } = folder();
  for (const cmd of ['ls -la', 'git status', 'git log --oneline -5', 'git diff HEAD']) assert.ok(!denied(guard(api, cmd)), cmd);
});

test('guard bloquea reset --hard, push forzado y clean -f', () => {
  const { api } = folder();
  for (const cmd of [
    'git reset --hard HEAD~1',
    'git push -f origin main',
    'git push origin main --force-with-lease',
    'git push origin +main',
    'git clean -fd',
    'git -C . clean -xdf',
  ]) {
    assert.ok(denied(guard(api, cmd)), cmd);
  }
  assert.ok(!denied(guard(api, 'git clean -nd')), 'el dry-run no borra nada');
  assert.ok(!denied(guard(api, 'git push -u origin feature/x')), '-u no es forzar');
});

test('guard bloquea la ejecución de forbidden del manifiesto, en sus formas usuales', () => {
  const { root, api } = folder();
  for (const [cwd, cmd] of [
    [api, 'npm run lint'],
    [root, 'cd api && npm run lint'],
    [root, 'cd client && npm run lint -- --quiet'],
    [path.join(root, 'client'), 'npx ng lint'],
    [path.join(root, 'client'), 'ng lint'],
    [root, 'powershell -Command "cd api; npm run lint"'],
    [api, 'npm run format'],
  ]) {
    const r = guard(cwd, cmd);
    assert.ok(denied(r), `no bloqueó: ${cmd}`);
    assert.match(reason(r), /forbidden/);
  }
});

test('un forbidden que toca una base se niega con su propio motivo: lo corre la persona', () => {
  const root = h.tmp('guard-db');
  const forbidden = ['npm run lint', 'npm run acl:sync', 'npm run prisma:push', 'prisma migrate dev', 'prisma db push'];
  h.repo(root, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', forbidden })), 'src/a.ts': 'a\n' });
  for (const cmd of ['npm run acl:sync', 'npm run acl:sync -- --apply', 'npm run prisma:push', 'npx prisma migrate dev --name talleres', 'npx prisma db push']) {
    const r = guard(root, cmd);
    assert.ok(denied(r), cmd);
    assert.match(reason(r), /: toca una base: lo corre la persona desde su terminal, sabiendo contra qué base apunta el \.env\.$/, cmd);
  }
  assert.match(reason(guard(root, 'npm run lint')), /reescribe archivos en masa/);
  assert.equal(guard(root, 'npx prisma migrate status').out, null, 'leer el estado no escribe');
});

test('guard NO bloquea mencionar un forbidden dentro de otro comando', () => {
  const { api } = folder();
  for (const cmd of ['grep "npm run lint" CLAUDE.md', 'echo "nunca uses npm run lint"', 'rg --files-with-matches "ng lint"', 'cat <<EOF\nnpm run lint\nEOF']) {
    assert.ok(!denied(guard(api, cmd)), `bloqueó una mención: ${cmd}`);
  }
});

test('guard permite eslint sin --fix, que es la verificación correcta', () => {
  const { root } = folder();
  assert.ok(!denied(guard(root, 'cd api && npx eslint src/a.ts --max-warnings=0')));
});

test('guard bloquea el commit cuando no puede determinar el workspace', () => {
  const { root } = folder();
  const r = guard(root, 'git commit -m x');
  assert.ok(denied(r));
  assert.match(reason(r), /no se sabe a qué workspace va/);
});

test('guard bloquea commit sin bandera y lo permite con bandera vigente de ese workspace', () => {
  const { root, api, client } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'cambio\n');
  const r = guard(api, 'git commit -m x');
  assert.ok(denied(r));
  assert.match(reason(r), /sin bandera de verificación vigente/);
  assert.match(reason(r), /Verifica con \/arnes:verify, que escribe la bandera solo si el gate pasa; nunca la escribas a mano/);
  assert.doesNotMatch(reason(r), /gate-flag\.js/);
  flag(root, 'api');
  assert.ok(!denied(guard(api, 'git commit -m x')));
  assert.ok(denied(guard(client, 'git commit -m y')), 'la bandera de api no sirve para client');
  flag(root, 'client');
  assert.ok(!denied(guard(client, 'git commit -m y')));
});

test('guard resuelve -C, -C con -c antes, y el último cd del comando', () => {
  const { root, api } = folder();
  flag(root, 'api');
  assert.ok(!denied(guard(root, `git -C "${api}" commit -m x`)));
  assert.ok(!denied(guard(root, `git -c core.quotePath=false -C "${api}" commit -m x`)));
  assert.ok(!denied(guard(root, `cd "${api}" && git commit -m x`)));
  assert.ok(!denied(guard(root, 'cd api && git commit -m x')), 'cd relativo al cwd del evento');
  assert.ok(denied(guard(root, 'cd api && cd .. && git commit -m x')), 'el último cd vuelve a la raíz');
});

test('guard bloquea bandera vencida, de otro HEAD o en fail', () => {
  const { root, api } = folder();
  const file = path.join(root, '.tmp', 'harness', 'gate', 'api.json');
  flag(root, 'api');
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...f, at: '2020-01-01T00:00:00.000Z' }));
  assert.match(reason(guard(api, 'git commit -m x')), /vencida/);
  fs.writeFileSync(file, JSON.stringify({ ...f, head: 'deadbeef' }));
  assert.match(reason(guard(api, 'git commit -m x')), /HEAD cambió/);
  flag(root, 'api', 'fail');
  assert.match(reason(guard(api, 'git commit -m x')), /terminó en "fail"/);
});

test('guard: un archivo nuevo o un trackeado no verificado, editado después de la bandera, bloquea', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'verificado\n');
  flag(root, 'api');
  assert.ok(!denied(guard(api, 'git commit -m x')));
  h.write(api, 'src/nuevo.ts', 'sin verificar\n');
  assert.match(reason(guard(api, 'git commit -m x')), /lista de archivos tocados cambió/);
  fs.unlinkSync(path.join(api, 'src/nuevo.ts'));
  fs.appendFileSync(path.join(api, 'README.md'), 'editado después\n');
  assert.ok(denied(guard(api, 'git commit -m x')));
});

test('guard: hacer git add de lo verificado no invalida la bandera', () => {
  const { root, api } = folder();
  h.write(api, 'src/staged.ts', 'contenido\n');
  flag(root, 'api');
  h.git(api, 'add', 'src/staged.ts');
  assert.ok(!denied(guard(api, 'git commit -m x')));
});

test('guard bloquea add masivo con .env o logs sin trackear, también vía -C; .env.example pasa', () => {
  const { root, api } = folder();
  for (const f of ['.env', '.env.local', 'salida.log']) {
    h.write(api, f, '');
    assert.ok(denied(guard(api, 'git add .')), f);
    assert.ok(denied(guard(root, `git -C "${api}" add -A`)), `${f} vía -C`);
    fs.unlinkSync(path.join(api, f));
  }
  h.write(api, '.env.example', '');
  assert.ok(!denied(guard(api, 'git add .')));
  h.write(api, '.env', '');
  assert.ok(!denied(guard(api, 'git add src/a.ts')), 'add explícito no es masivo');
});

// ---------- falsos positivos y casos nuevos ----------

test('falso positivo: un heredoc que contiene las palabras git y commit no se bloquea', () => {
  const { root, api } = folder();
  const nota = "cat > docs/nota.md <<'EOF'\nPara cerrar: git commit -m listo\ny nunca git reset --hard ni git push --force.\nEOF";
  assert.ok(!denied(guard(api, nota)));
  assert.ok(!denied(guard(root, nota)), 'tampoco desde la raíz, donde un commit real se bloquearía');
});

test('un commit con mensaje por heredoc se juzga como commit, no por el texto del mensaje', () => {
  const { root, api } = folder();
  fs.appendFileSync(path.join(api, 'src/a.ts'), 'x\n');
  const cmd = "git commit -F - <<'EOF'\nfeat: algo\n\ngit reset --hard no aplica aquí\nEOF";
  assert.match(reason(guard(api, cmd)), /sin bandera de verificación vigente/);
  flag(root, 'api');
  assert.ok(!denied(guard(api, cmd)));
});

test('PowerShell: here-string con texto de git pasa; reset --hard real se bloquea', () => {
  const { api } = folder();
  const ps = "$msg = @'\ngit reset --hard\ngit push --force\n'@\nWrite-Output $msg";
  assert.ok(!denied(guard(api, ps, { tool: 'PowerShell' })));
  assert.ok(denied(guard(api, 'Set-Location src; git reset --hard', { tool: 'PowerShell' })));
});

test('branch -D: deniega una rama con commits sin mergear y permite una ya integrada', () => {
  const { api } = folder();
  h.git(api, 'checkout', '-q', '-b', 'tema');
  h.write(api, 'src/tema.ts', 'x\n');
  h.commitAll(api, 'tema');
  h.git(api, 'checkout', '-q', 'main');
  const r = guard(api, 'git branch -D tema');
  assert.match(reason(r), /git branch -D tema: tiene 1 commit\(s\) que no están en main/);
  assert.ok(denied(guard(api, 'git branch --delete --force tema')));
  assert.ok(!denied(guard(api, 'git branch -d tema')), '-d sin forzar lo decide git');
  h.git(api, 'merge', '-q', '--no-ff', '-m', 'integra tema', 'tema');
  assert.ok(!denied(guard(api, 'git branch -D tema')));
});

test('git worktree remove: deniega con commits sin integrar y permite después del merge', () => {
  const { api } = folder();
  h.git(api, 'worktree', 'add', '-q', '.claude/worktrees/wt', '-b', 'wt/main/tarea');
  const wt = path.join(api, '.claude', 'worktrees', 'wt');
  h.write(wt, 'src/hecho.ts', 'x\n');
  h.commitAll(wt, 'trabajo del agente');
  assert.match(reason(guard(api, 'git worktree remove .claude/worktrees/wt')), /su rama wt\/main\/tarea tiene 1 commit/);
  assert.ok(denied(guard(api, 'git worktree remove --force .claude/worktrees/wt')));
  h.git(api, 'merge', '-q', '--no-ff', '-m', 'integra', 'wt/main/tarea');
  assert.ok(!denied(guard(api, 'git worktree remove .claude/worktrees/wt')));
});

test('sin manifiesto: git destructivo se deniega igual; commit, add y forbidden no se juzgan', () => {
  const dir = h.tmp('guard-sin');
  h.repo(dir, { 'a.ts': 'a\n' });
  h.write(dir, '.env', 'secreto');
  for (const cmd of ['git reset --hard', 'git push --force', 'git clean -f']) assert.ok(denied(guard(dir, cmd)), cmd);
  for (const cmd of ['git commit -m x', 'git add .', 'npm run lint']) assert.ok(!denied(guard(dir, cmd)), cmd);
  h.git(dir, 'checkout', '-q', '-b', 'tema');
  h.write(dir, 'b.ts', 'b\n');
  h.git(dir, 'add', 'b.ts');
  h.git(dir, 'commit', '-q', '-m', 'tema');
  h.git(dir, 'checkout', '-q', 'main');
  assert.ok(denied(guard(dir, 'git branch -D tema')), 'branch -D también sin manifiesto');
});

test('cwd dentro de un worktree: vale la bandera del worktree, no la del checkout principal', () => {
  const { root, api } = folder();
  h.git(api, 'worktree', 'add', '-q', '.claude/worktrees/wt', '-b', 'wt/main/x');
  const wt = path.join(api, '.claude', 'worktrees', 'wt');
  fs.appendFileSync(path.join(wt, 'src/a.ts'), 'en el worktree\n');
  const env = { CLAUDE_PROJECT_DIR: api };
  flag(root, 'api');
  assert.match(reason(guard(wt, 'git commit -m x', { env })), /sin bandera de verificación vigente/, 'la bandera de la carpeta no cubre el worktree');
  flag(wt, 'api');
  assert.ok(!denied(guard(wt, 'git commit -m x', { env })));
});

// ---------- lectura de secretos por shell ----------

test('cat, type, Get-Content y head de un secreto se deniegan, haya o no manifiesto', () => {
  const dir = h.tmp('guard-leer');
  h.repo(dir, { 'a.ts': 'a\n' });
  for (const cmd of [
    'cat .env',
    'cat config/.env.production',
    'cat src/a.ts .env',
    'cat < .env',
    'head -n 5 .env.local',
    'cat ~/.ssh/id_rsa',
    'cd config && cat .env',
    'type .env',
    'bash -c "cat .env | grep KEY"',
    'cat certs/server.key',
  ]) {
    assert.ok(denied(guard(dir, cmd)), cmd);
  }
  for (const cmd of ['Get-Content .env', 'Get-Content -Path .env -Raw', 'gc .env.local', 'type .env', 'cat .env']) {
    assert.ok(denied(guard(dir, cmd, { tool: 'PowerShell' })), `PowerShell: ${cmd}`);
  }
  assert.match(reason(guard(dir, 'cat .env')), /^arnes guard: cat \.env: es un archivo \.env\. Los secretos no entran al transcript; .*\.env\.example/);
});

test('solo se juzgan los archivos que leen: escribir un .env, mencionarlo o leer .env.example pasa', () => {
  const dir = h.tmp('guard-leer-ok');
  h.repo(dir, { 'a.ts': 'a\n' });
  for (const cmd of [
    'cat .env.example',
    'cat README.md src/a.ts',
    "cat > .env <<'EOF'\nAPI_KEY=x\nEOF",
    'cat >> .env.local <<EOF\nX=1\nEOF',
    'echo "nunca hagas cat .env"',
    'grep -rn "cat .env" docs',
    'cat <<EOF\ncat .env\nEOF',
    'head -n 5 deploy/id_ed25519.pub',
    'type git',
  ]) {
    assert.ok(!denied(guard(dir, cmd)), cmd);
  }
});

test('con manifiesto, secretPaths del workspace también se deniegan por shell', () => {
  const dir = h.tmp('guard-leer-manif');
  h.repo(dir, { '.claude/harness.json': h.repoManifest('api', h.workspace({ name: 'api', secretPaths: ['config/secrets/**'] })) });
  assert.match(reason(guard(dir, 'cat config/secrets/db.yml')), /está en secretPaths de api/);
  assert.ok(!denied(guard(dir, 'cat config/app.yml')));
});

// ---------- destino del registro de worktrees ----------

test('worktree remove y branch -D miden contra la rama del issue registrada, no contra main', () => {
  const dir = h.tmp('guard-ledger');
  h.repo(dir, { '.gitignore': '.tmp/\n', '.claude/harness.json': h.repoManifest('api'), 'a.ts': 'a\n' });
  h.git(dir, 'checkout', '-q', '-b', 'feature/x');
  assert.equal(h.run('worktree-ledger.js', ['open', 'tarea'], { cwd: dir }).status, 0);
  const wt = path.join(dir, '.tmp', 'harness', 'worktrees', 'api', 'tarea');
  h.write(wt, 'b.ts', 'b\n');
  h.commitAll(wt, 'trabajo');
  assert.match(reason(guard(dir, `git worktree remove "${wt}"`)), /su rama wt\/feature\/x\/tarea tiene 1 commit\(s\) que no están en feature\/x/);
  assert.match(reason(guard(dir, 'git branch -D wt/feature/x/tarea')), /que no están en feature\/x/);
  h.git(dir, 'merge', '-q', '--no-ff', '-m', 'integra', 'wt/feature/x/tarea');
  assert.ok(!denied(guard(dir, `git worktree remove "${wt}"`)), 'integrado en la rama del issue, aunque no en main');
  assert.ok(!denied(guard(dir, 'git branch -D wt/feature/x/tarea')));
  h.git(dir, 'checkout', '-q', '-b', 'tema');
  h.write(dir, 'c.ts', 'c\n');
  h.commitAll(dir, 'tema');
  h.git(dir, 'checkout', '-q', 'feature/x');
  assert.match(reason(guard(dir, 'git branch -D tema')), /que no están en main/, 'una rama fuera del registro sigue midiéndose contra main');
});

test('un error propio sale con 0 y no decide nada', () => {
  const r = h.run('hooks/guard.js', [], { input: 'esto no es json' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /arnes guard: error interno/);
});
