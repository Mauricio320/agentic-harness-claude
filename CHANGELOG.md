# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado semver: un tag `vX.Y.Z` cubre `arnes`, `arnes-ui` y `arnes-mod`.

## [0.4.0] - sin etiquetar

Fase 2b: mod de interfaz. Escrito contra los tipos de la API de mods de Claude Code 2.1.303. `claude plugin validate` y `claude plugin test` corrieron con 2.1.304, porque el CLI se actualizó solo durante la sesión. La prueba manual (`docs/PRUEBA-FASE-2B.md`) se hizo el 2026-10-19 con 2.1.304; su resultado está al final de la guía. La repetición tras las correcciones salió como está escrita, y la fase 2b queda cerrada.

### Añadido
- `arnes-ui`: `hooks/register.tsx` con los hooks y el dibujo, `hooks/lib.ts` con lo puro (rutas, globs, formatos, lectura de comandos y de git) y el contrato de `$.state` en `types/index.d.ts`.
- Etapa por eventos:
  - `skill.prompt` de las skills `arnes:`.
  - `agent.spawn` y `turn.complete` de `arnes:dev`, `arnes:reviewer` y `arnes:test-writer`.
  - `tool.call` de los Bash que corren `ci-gate`, `typecheck-baseline`, `test-select`, o un segmento que empieza por un typecheck o un test del manifiesto.
  - `turn.step` muestra "Pensando…" y `session.compact` avisa.
- Banda de una línea sobre el prompt y entrada en la status line. Toast en cambio de etapa. Aviso en gate en rojo, Stop bloqueado, zona de riesgo tocada y compactación: va como toast y además como línea en el transcript (`$.ui.log`).
- El aviso de Stop bloqueado sale de la nota `bloqueado` que el `stop-gate` deja en la timeline, leída con el reloj del mod, y no de un hook en `classic.Stop`.
- La bandera se ve vencida si un archivo cambiado se modificó después de escribirla, por cualquier vía: el mod compara la fecha de modificación de lo que lista git, que se relee cada 15 s.
- Panel con la cronología (duración y costo por etapa), el promedio de las últimas corridas, los agentes con su botón "ver", el gate por workspace, el plan, la timeline y lo que sigue. `/arnes-panel` lo abre o lo cierra.
- Las últimas 20 corridas quedan en `$.store`. Cada corrida cierra con un resumen por etapa que marca la más lenta y la más cara.
- Tests del mod con `claude plugin test plugins/arnes-ui`.
- `/arnes:timeline` y `timeline.js print`: la timeline como texto, con la duración por etapa. Funcionan sin el mod.
- `docs/PRUEBA-FASE-2B.md` con la prueba manual.

### Cambiado
- `stop-gate` solo bloquea un turno que cambió la lista o el contenido de los tocados respecto de la foto que deja `prompt-context` en cada prompt (`.tmp/harness/turn.json`). Un turno que no tocó nada solo avisa.
- `arnes-ui` deduce el workspace de un comando de `cd`, `-C`, `--prefix` o el cwd. Si no puede, la etapa va sin workspace y no marca ningún gate; antes caía en el primer repo de la composición.
- `gate-flag`: la bandera lleva `contentHash`, el hash del contenido de cada tocado, trackeado o no. Editar un archivo ya tocado la vence. Una bandera escrita antes, sin ese campo, ya no vale.
- `stop-gate` anota cada bloqueo en la timeline (nota `bloqueado`), además del pase con `stop_hook_active`.
- `docs/PLAN.md` §3 registra tres hechos de la prueba manual con 2.1.304: un plugin interno salta el `classic.Stop` de los mods, que un toast se vea depende de la superficie, y el motor pone el prefijo de la status line de un mod.
- `docs/PLAN.md` §3 registra cuatro hechos de la API de mods 2.1.303: `process.spawn` no ve el Bash del modelo, el costo por etapa sale de `$.session.usage()`, un comando registrado no lleva prefijo de plugin y un mod no puede calcular la vigencia exacta de la bandera. §6.5b y §10 se ajustan a ellos.

## [0.3.0] - sin etiquetar

Fase 2: hooks clásicos. Probado con Claude Code 2.1.303 y Node 24 con tests por stdin. La prueba manual en una sesión interactiva se hizo el 2026-10-19 en api-academico; su resultado está al final de `docs/PRUEBA-FASE-2.md`.

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
- `adoption-check` comprobación 7: un hook del `.claude/settings.json` de un repo o de la carpeta que corre un script propio de `.claude/hooks/` es una falta, porque corre además de los del plugin y pelea con ellos.

### Cambiado
- `docs/PLAN.md` §6.2: el rechazo de borrar worktrees pasa de `WorktreeRemove` a `PreToolUse` sobre `ExitWorktree` y al guard, porque `WorktreeRemove` solo se dispara para worktrees creados por un hook `WorktreeCreate`. Las reglas destructivas de git del guard valen también sin manifiesto.
- `touched-files` excluye el `.tmp/harness/` del proyecto, para que la propia bandera no cuente como archivo tocado en un proyecto de un solo repo.
- La timeline admite el evento `note`, que escriben los hooks.
- `docs/PLAN.md` §3 y §8: adoptar un repo empieza por quitar los hooks del arnés anterior de su `.claude/settings.json`; api-academico y renova365 los tienen.

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
