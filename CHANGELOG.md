# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado semver: un tag `vX.Y.Z` cubre `arnes`, `arnes-ui` y `arnes-mod`.

## [0.3.0] - sin etiquetar

Fase 2: hooks clásicos. Probado con Claude Code 2.1.303 y Node 24 con tests por stdin. La prueba manual en una sesión interactiva (`docs/PRUEBA-FASE-2.md`) está pendiente.

### Añadido
- `hooks/hooks.json` con `SessionStart`, `UserPromptSubmit`, `PreToolUse` (`Bash|PowerShell` y `ExitWorktree`), `PostToolUse` (`Edit|Write`) y `Stop`. Cada hook corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<x>.js"` con su timeout y su statusMessage.
- `guard.js`: parseo por segmentos que nunca mira heredocs ni argumentos de `echo`/`cat`. Deniega siempre `reset --hard`, push forzado, `clean -f`, `branch -D` y `git worktree remove` con commits sin integrar; con manifiesto, además, `forbidden`, `git commit` sin bandera vigente y `git add` masivo con `.env` o logs.
- `after-edit.js`: lint del archivo editado como contexto, y `typecheckFast` con debounce de 20 s por workspace; nunca bloquea.
- `session-start.js`: workspaces con rama y árbol sucio, últimas cinco decisiones y protocolo, todo en 40 líneas como máximo; sin manifiesto, cómo crearlo.
- `prompt-context.js`: estado corto con la bandera y las riskPaths tocadas.
- `stop-gate.js`: un bloqueo por turno si hay código sin bandera vigente; con `stop_hook_active`, aviso visible y nota en la timeline.
- `worktree-remove.js`: deniega `ExitWorktree` con `action: "remove"` si la rama del worktree tiene commits sin integrar.
- `lib/hook.js`, `lib/shell.js` y `lib/branches.js`.
- Tests por stdin para cada hook, incluidos el cwd dentro de un worktree, `stop_hook_active`, un archivo fuera de todo workspace y el falso positivo del heredoc; casos portados del git-guard de renova365.
- Permisos recomendados en el README.
- `docs/PRUEBA-FASE-2.md` con la prueba manual.

### Cambiado
- `docs/PLAN.md` §6.2: el rechazo de borrar worktrees pasa de `WorktreeRemove` a `PreToolUse` sobre `ExitWorktree` y al guard, porque `WorktreeRemove` solo se dispara para worktrees creados por un hook `WorktreeCreate`. Las reglas destructivas de git del guard valen también sin manifiesto.
- `touched-files` excluye el `.tmp/harness/` del proyecto, para que la propia bandera no cuente como archivo tocado en un proyecto de un solo repo.
- La timeline admite el evento `note`, que escriben los hooks.

## [0.2.0] - sin etiquetar

Fase 1: manifiesto y scripts. Probado con Claude Code 2.1.303 y Node 24, en academico (tres repos, uno PHP no adoptable todavía) y renova365 (dos repos).

### Añadido
- `schema/harness.schema.json` con los dos niveles del manifiesto: de repo (`workspaces`, con sus comandos) y composición de carpeta (`repos`, con `integration` y `contract`). `specPattern` acepta string o lista.
- `scripts/lib/manifest.js`: busca el manifiesto subiendo desde el cwd, compone repo y carpeta, valida contra el schema sin dependencias y resuelve el workspace de una ruta.
- `scripts/lib/timeline.js`, `lib/glob.js` y `lib/exec.js`.
- `touched-files.js`, `typecheck-baseline.js` (portado de renova365: clave sin línea ni columna, conteos por clave, exit 0/1/2/3/4), `test-select.js`, `gate-flag.js`, `adoption-check.js` y `ci-gate.js`. Todos leen del manifiesto, aceptan `--help` y documentan sus exit codes en la cabecera.
- `init-draft.js` y la skill `/arnes:init` completa: genera el manifiesto de cada repo y la composición de la carpeta, los valida, y con `--check` corre `adoption-check`.
- Tests con `node --test` sobre repos de juguete, con los casos portados de `harness-tests.js` de renova365 y los manifiestos reales como fixtures. Job `test` en el CI.

### Cambiado
- `docs/PLAN.md` §5: la unidad del manifiesto pasa a ser el repo, porque el CI de cada repo no veía el manifiesto de la carpeta. La carpeta pasa a ser una composición.
- El marketplace pasa de `claude-harness` a `agentic-harness`, para coincidir con el repo de GitLab.

## [0.1.0] - 2026-10-19

Fase 0: esqueleto. Probado con Claude Code 2.1.303.

### Añadido
- Marketplace `claude-harness` en `.claude-plugin/marketplace.json` con los plugins `arnes`, `arnes-ui` y `arnes-mod`.
- Plugin `arnes` con las carpetas `skills`, `agents`, `hooks`, `scripts` y `tests`, y la skill `/arnes:init` solo como esqueleto.
- Plugins `arnes-ui` y `arnes-mod` con solo su `plugin.json`; `arnes-mod` declara `arnes` como dependencia.
- README con principios, instalación, versionado en dos capas y matriz de compatibilidad.
- CI de GitLab que corre `claude plugin validate --strict` sobre el marketplace y los tres plugins.

### Cambiado
- El plan pasa de `PLAN-ARNES.md` a `docs/PLAN.md`.
