'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PLUGIN = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));

test('hooks.json declara los eventos de §6.2 con sus matchers; SubagentStop y WorktreeRemove no', () => {
  assert.deepEqual(Object.keys(config.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.deepEqual(config.hooks.PreToolUse.map((g) => g.matcher), ['Bash|PowerShell', 'ExitWorktree']);
  assert.deepEqual(config.hooks.PostToolUse.map((g) => g.matcher), ['Edit|Write']);
});

test('cada hook llama a node con la ruta del script entre comillas, timeout y statusMessage propios', () => {
  const scripts = [];
  for (const groups of Object.values(config.hooks)) {
    for (const g of groups) {
      for (const hk of g.hooks) {
        const m = hk.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hooks\/([a-z-]+\.js)"$/);
        assert.ok(m, `forma inesperada: ${hk.command}`);
        assert.ok(fs.existsSync(path.join(PLUGIN, 'scripts', 'hooks', m[1])), `${m[1]} no existe`);
        assert.equal(hk.type, 'command');
        assert.ok(Number.isInteger(hk.timeout) && hk.timeout > 0, `${m[1]} sin timeout`);
        assert.match(hk.statusMessage, /^arnes: /);
        scripts.push(m[1]);
      }
    }
  }
  assert.deepEqual(scripts.sort(), ['after-edit.js', 'guard.js', 'prompt-context.js', 'session-start.js', 'stop-gate.js', 'worktree-remove.js']);
});
