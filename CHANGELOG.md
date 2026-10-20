# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado semver: un tag `vX.Y.Z` cubre `arnes`, `arnes-ui` y `arnes-mod`.

## [0.5.0] - 2026-10-20

Fase 3: el flujo completo plan → build → verify → review → ship, con los cuatro agentes, los worktrees por issue, la memoria en markdown y la línea base de tests. Se construyó en dos mitades en paralelo, la 3a (verify, review y ship) y la 3b (plan, build, worktree, memory y sync), y se integró en `feature/fase-3`. Probado con Claude Code 2.1.304 y Node 24, con tests de juguete y de punta a punta sobre un clon local de api-academico. La prueba manual de `docs/PRUEBA-FASE-3.md` se hizo el 2026-10-20 en una sesión interactiva; su resultado está al final de la guía, y la fase 3 queda cerrada.

### Añadido
- `/arnes:plan` y `/arnes:build`, invocables por el modelo:
  - plan lee el issue con glab o gh, o toma el texto, y consulta graphify si existe. Escribe `.tmp/harness/plan.md` con criterios literales e inferidos, contrato, datos, archivos previstos, zonas de riesgo y preguntas cerradas, pide confirmación y anota `Aprobado:`.
  - build exige el plan aprobado y lanza un `arnes:dev` por workspace, el back primero, con el contrato textual.
- `/arnes:memory`, invocable por el modelo: decisiones en `docs/decisions/`, gotchas en `docs/gotchas.md` y recall con Grep y graphify, sin MCP.
- `/arnes:worktree` y `/arnes:sync`, solo por la persona: los worktrees por tarea, y traer `origin/<rama>` con respaldo, merge sin squash, `merged-files` y verify.
- Agente `dev` (sonnet, effort medium): implementa un workspace siguiendo su `CLAUDE.md` y sus rules, sin tests. Devuelve contrato, archivos, desviaciones, cobertura con `archivo:línea`, riesgo y pendientes.
- `worktree-ledger.js`:
  - abre worktrees por tarea en `wt/<rama-issue>/<slug>` desde la rama del issue, bajo `.tmp/harness/worktrees/`, con registro en `.tmp/harness/worktrees.json`;
  - integrate hace `merge --no-ff`, nunca squash, y close solo cierra sin commits propios;
  - pending sale con 1 si queda algo abierto.
- `merged-files.js`: lo que tocaron los dos lados de un merge y lo que entró.
- `SessionEnd` en `hooks.json`: suelta el lock de la sesión.
- `/arnes:verify`, invocable por el modelo. Por cada workspace tocado corre `ci-gate.js --base HEAD`: el typecheck contra una foto del HEAD, el lint de los tocados y los specs de test-select con la línea base. Lanza `arnes:test-writer` solo si hay código nuevo sin spec, escribe la bandera solo si el gate salió con 0 y anota la etapa en la timeline.
- `/arnes:review`, invocable por el modelo. Lanza `arnes:reviewer` una sola vez sobre el árbol final, con la entrada de `review.js input` y el plan si existe. Marca la revisión con `review.js mark` y resume los hallazgos por archivo, bloqueantes primero.
- `/arnes:ship`, solo por la persona:
  - exige bandera vigente y revisión del árbol actual sin bloqueantes;
  - usa la misma rama con el prefijo del manifiesto en los workspaces tocados;
  - hace un commit por workspace, back antes que front, con la convención del repo;
  - pide confirmación explícita antes de cualquier push o MR. Los MR van por `glab` o `gh`, con los enlaces cruzados y REVISIÓN HUMANA OBLIGATORIA si tocó riskPaths;
  - se niega con worktrees del issue sin integrar: `ship.js check` consulta el registro, y la skill corre `worktree-ledger.js pending --target <rama>` y muestra su salida.
  `--solo-commit` se detiene después de commitear.
- Agentes, cada uno con su `model` y su `effort`:
  - `reviewer` (opus): solo lectura con Read, Grep y Glob. Aplica la lista cerrada de bloqueantes de §6.4 y las reglas duras de `.claude/rules`, revisa el cumplimiento de criterios si hay plan y marca REVISIÓN HUMANA OBLIGATORIA.
  - `test-writer` (sonnet): specs solo para código nuevo o cambiado, contra el estándar de tests del repo.
  - `test-runner` (haiku): corre `test-baseline.js check` y copia la salida sin reclasificar.
- `test-baseline.js` (mejora 1 de §6.1): la línea base de tests commiteada.
  - Guarda conteos por spec y los saltos por nombre, con el formato `$defs.testBaselineFile` del schema y la ruta `testBaseline` opcional en el workspace.
  - Un test borrado o saltado, o un spec de la base que ya no existe, pone el gate en rojo.
  - Las fallas que coinciden exacto con una línea fechada de `tests/known-failures.txt` salen como preexistentes y no ponen rojo.
  - Con más tests que en la base, una nota avisa que los nuevos quedan protegidos solo al recapturarla.
- `review.js` (input, mark, check) y `ship.js` (check, branch, stage).
- `test-select --missing` y `touched-files --workspaces`.
- `adoption-check` comprobación 8: la línea base de tests, válida y commiteada.
- `arnes-ui` muestra los worktrees sin integrar de `.tmp/harness/worktrees.json`: `N wt sin integrar` en la banda, una sección en el panel, y "Lo que sigue" pide `/arnes:worktree integrate`.
- Tests con `node --test` para todo lo anterior. Incluyen:
  - la salida real de jest 30 en Windows como fixture;
  - una carpeta de juguete de dos repos para el ledger, merged-files, la sesión concurrente, los worktrees en SessionStart y en el Stop, el destino del ledger en ExitWorktree y en el guard, y la lectura de secretos por shell;
  - un test de presupuesto de líneas y política de invocación de las diez skills y los cuatro agentes.
  Más un test de `claude plugin test` para los worktrees en `arnes-ui`.
- `docs/PRUEBA-FASE-3.md` con la prueba manual, que reemplaza a las de las dos mitades.

### Cambiado
- `ci-gate` juzga sus tests con `test-baseline.js`. Un spec de la base borrado o una base ilegible ya no pasan como "sin cambios de código".
- `ci-gate`, y con él verify, reutiliza la foto de typecheck del base en `.tmp/harness/typecheck/<ws>.txt` mientras su hash sea el mismo, y solo la captura cuando cambió.
- El protocolo de `session-start`, el motivo del `Stop` y el del guard nombran las skills: verificar es `/arnes:verify`, revisar es `/arnes:review` e integrar es `/arnes:worktree integrate`. Ninguno manda ya a escribir la bandera a mano. El protocolo nombra además la lectura de secretos por shell entre lo denegado siempre.
- `session-start`:
  - lista los worktrees sin integrar y avisa de los de más de 7 días sin commits nuevos;
  - avisa si otra sesión de Claude está activa en el mismo proyecto, con un lock propio en `.tmp/harness/sessions`, y le pide a la segunda que trabaje en un worktree.
- `stop-gate` hace efectiva la condición (b): bloquea una vez el turno que dejó commits sin integrar en un worktree del issue.
- `worktree-remove` y el guard miden los commits sin integrar contra la rama destino registrada en el ledger. El comentario de `lib/branches.js` lo dice.
- El guard deniega `cat`, `type`, `Get-Content` y `head` de archivos de secretos, juzgando solo los archivos que leen. `read-guard.js` exporta `secretPath`.
- El validador de `lib/manifest.js` admite `additionalProperties` como schema y `minimum`, y valida contra una definición de `$defs` (`validateDef`).
- `docs/PLAN.md` §3, §4, §6, §7, §8, §10 y §12 registran los cambios y las decisiones de la fase 3.

### Quitado
- `docs/PRUEBA-FASE-3A.md` y `docs/PRUEBA-FASE-3B.md`, reemplazadas por `docs/PRUEBA-FASE-3.md`, y `docs/NOTAS-FASE-3B.md`, ya llevado al plan, al CHANGELOG y al README.

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
- `read-guard.js`, un `PreToolUse` sobre Read, Glob y Grep: deniega abrir o buscar en `.env` y variantes (salvo `.env.example`), `~/.ssh`, `~/.aws`, credenciales, tokens y llaves privadas, haya o no manifiesto. `secretPaths` en el manifiesto amplía la lista por workspace. Es la mejora 2 de `docs/PLAN.md` §6.2.

### Cambiado
- `docs/PLAN.md` registra tres mejoras tomadas de otros arneses: la línea base de tests commiteada (§6.1 y §8, fase 3), el guard de lectura de secretos (§6.2) y el aviso de sesión concurrente (§6.2 y §7, fase 3). También registra la fase 7 de publicación (§10) y, en §12, la decisión abierta sobre la comunidad de plugins de Anthropic.
- Las guías de prueba usan `$PDV` en los comandos y `<PDV>` en los textos esperados, en vez de la ruta personal.
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
