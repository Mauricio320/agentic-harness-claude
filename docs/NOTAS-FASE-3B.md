# Notas de la fase 3b (plan, build, worktrees, memoria y sync)

Rama `feature/fase-3b-plan-build`, creada desde `feature/fase-2b-ui`. La fase 3a construye en paralelo verify, review, ship, los agentes reviewer, test-writer y test-runner, la línea base de tests y el punto 8 de adoption-check. Este archivo junta lo que hay que llevar a `docs/PLAN.md`, `CHANGELOG.md` y `README.md` cuando las dos ramas estén mergeadas. Esos tres archivos no se tocaron en esta rama, y la versión de los plugins tampoco.

## Para docs/PLAN.md

### §3, hechos verificados

- Una sesión no puede lanzar otra sesión de Claude Code. Desde una sesión en modo auto, el clasificador de permisos negó `claude -p` anidado por considerarlo un desvío del modo auto. La prueba de las skills dentro de una sesión real con el plugin cargado la hace la persona (`docs/PRUEBA-FASE-3B.md`). En esta fase, las skills se ejecutaron siguiendo su texto sobre el clon, y el dev se lanzó como agente con el texto de `agents/dev.md`, en sonnet.
- Claude Code pone `CLAUDE_PID` (su propio pid) en el entorno de los procesos que lanza. Se vio en el entorno del Bash del modelo, y el binario de 2.1.304 arma ese entorno junto con `CLAUDECODE` y `CLAUDE_CODE_SESSION_ID`. Falta comprobar que llegue también a los hooks: es el paso 1 de la prueba manual. Si no llega, el lock de sesión queda sin pid y vale por su fecha (24 h), o hasta que su sesión lo suelta en `SessionEnd`.

### §4, estructura

- `hooks/hooks.json` suma `SessionEnd`, que corre `session-start.js`. Ese script atiende los dos eventos: al arrancar escribe el lock de la sesión, y al cerrar lo borra. No hay script nuevo de hooks.
- `scripts/merged-files.js` y `scripts/worktree-ledger.js` ya estaban en el árbol del plan. Ahora existen.

### §6.1, scripts

- `worktree-ledger.js open|integrate|close <slug> [--ws n]... [--issue ref] | list [--all] [--json] | pending [--target rama] [--json]`.
  - El registro es `<raíz>/.tmp/harness/worktrees.json` = `{ "version": 1, "worktrees": [ { ws, path, branch, target, issue, openedAt, status, closedAt?, merge? } ] }`, con `status` abierto, integrado o cerrado.
  - Cada worktree vive en `<raíz>/.tmp/harness/worktrees/<ws>/<slug>`. En una carpeta multi-repo eso queda fuera de los repos. En un proyecto de un repo, `touched-files` ya excluye `.tmp/harness/`. No se usa `.claude/worktrees/`, que es la carpeta de los worktrees propios de Claude Code.
  - open se niega desde la rama por defecto (`defaultBranch`, o main y master), con HEAD suelto, con slug inválido o con una rama que ya existe. Sin `--ws`, abre uno por repo adoptable: en un monorepo, uno por repo y no uno por paquete.
  - integrate se niega si el worktree tiene cambios sin commitear, si el checkout principal no está en la rama destino, o si hay un merge a medias. Después hace `git merge --no-ff --no-edit` (nunca squash), borra el worktree y la rama con `branch -d`, y cierra el registro. Un conflicto deja el merge a medias y el registro abierto; resuelto y commiteado, otro integrate termina.
  - close cierra solo un worktree sin commits propios; con commits, se niega.
  - pending sale con 1 si queda algo abierto. Es lo que consultan ship y el Stop.
  - Desde dentro de un worktree, el registro es el del checkout principal (`git rev-parse --git-common-dir`).
  - El estado del arnés que deja una sesión dentro del worktree (`.tmp/harness/` del worktree) no cuenta como cambio sin commitear y se borra con él.
- `merged-files.js [--ws n]... [--ref commit] [--json]`: por workspace, `ambos` son los archivos que cambiaron los dos lados desde la base común, y `entró` son los que el merge cambió respecto del primer padre. Sale con 1 si el ref no es un merge, sea fast-forward o nada que traer.

### §6.2, hooks

- `SessionStart`:
  - Lista los worktrees abiertos del registro, cinco como máximo, con sus commits sin integrar. A los de más de 7 días sin commits nuevos les agrega `intégralo o ciérralo, nunca se borra solo`. "Sin commits nuevos" cuenta desde el último commit propio de la rama, o desde que se abrió si no tiene.
  - Mejora 3: cada sesión escribe `.tmp/harness/sessions/<session_id>.json` = `{ pid, session, cwd, at }`. Si ve el lock de otra sesión viva (pid existente y menos de 24 h), avisa en la segunda línea que esta sesión debe abrir su propio worktree. Un lock con pid muerto, de más de 24 h o ilegible se borra. Un lock con el mismo pid es de la misma sesión tras un `/clear`, y no avisa. `SessionEnd` borra el propio.
  - No se usan los archivos de sesión del CLI, solo el lock propio.
  - Sin manifiesto no hay lock: no hay `.tmp/harness` donde escribirlo.
  - Una sesión dentro de un worktree escribe su lock en el `.tmp/harness` del worktree, así que no avisa por la sesión del checkout principal, que es lo buscado.
- `Stop`, condición (b):
  - "Del issue" son los registros abiertos cuyo destino es la rama en que está el checkout principal de su workspace.
  - Bloquea si alguno tiene commits sin integrar y el último es posterior a la foto del turno (`turn.json`), con un segundo de margen porque git guarda la fecha en segundos. Si los commits son de un turno anterior, solo avisa, como la condición (a). Sin foto bloquea.
  - Una sesión dentro de un worktree no juzga (b): integrar le toca a la del checkout principal.
  - Con (a) y (b) a la vez, el bloqueo es uno solo y nombra las dos cosas. La nota de la timeline es `turno bloqueado sin verificar: …; sin integrar: …`, y la parte de (a) no cambió de forma, así que arnes-ui la sigue leyendo igual.
- `PreToolUse` sobre `ExitWorktree` (`worktree-remove.js`) y el guard (`git worktree remove`, `branch -D`) miden contra la rama destino registrada en el ledger cuando la rama o la carpeta están abiertas en él. Si no, siguen midiendo contra la rama por defecto. Un worktree integrado en la rama del issue y todavía no en main ya se puede borrar.
- Guard, lectura de secretos por shell: deniega `cat`, `type`, `Get-Content`, `gc` (alias de Get-Content) y `head` sobre los mismos archivos que `read-guard.js`, más los `secretPaths` del manifiesto.
  - Juzga solo los archivos que leen: no juzga opciones, ni el destino de `>` o `>>`, ni el marcador de heredoc. Escribir un `.env` con `cat > .env <<EOF` pasa, y `cat < .env` se deniega.
  - Aplica haya o no manifiesto.
  - La frase de §6.2 "Nunca mira texto de heredocs ni argumentos de `echo`/`cat`" pasa a ser: "Nunca mira texto de heredocs ni argumentos de `echo`; de `cat`, `type`, `Get-Content` y `head` mira solo los archivos que leen".
  - En la fila de `read-guard`, "un `cat .env` por Bash no lo mira este hook" pasa a ser "lo juzga el guard".

### §6.3 y §6.4, skills y agente

Tamaños: plan 42 líneas, build 33, worktree 46, memory 52, sync 34 y `agents/dev.md` 71.
- `plan` (invocable por el modelo):
  - Lee el issue con glab o gh según el remote, o toma el texto. Consulta graphify con `graphify query`, `explain` y `path` si existen `graphify-out/graph.json` y el comando `graphify`.
  - Escribe `plan.md` con estas secciones: título, Issue, Criterios `[literal]` o `[inferido]`, Contrato de API, Datos, Workspaces y orden, Archivos previstos, Zonas de riesgo, Preguntas y Fuera de alcance. Cada pregunta lleva Recomendación y Alternativa.
  - Pide confirmación. Con la respuesta, escribe `Aprobado:` y la sección `## Decisiones`.
  - La sección Archivos previstos no estaba en §6.3: hace falta para cotejar `riskPaths`.
- `build` (invocable por el modelo):
  - Exige `Aprobado:` en el plan. Lanza un `arnes:dev` por workspace, primero el back. El contrato va textual entre `--- contrato del back ---` y `--- fin del contrato ---`.
  - Comprueba las seis secciones del reporte y abre dos o tres líneas citadas. Relanza el dev una vez si falta un criterio.
  - Anota la timeline por workspace (`start` y `end build --ws`): una entrada global además de las de cada workspace duplicaría el total por etapa de `timeline print`.
- `worktree` (`disable-model-invocation`): open, integrate, close, list y pending sobre `worktree-ledger.js`. Después de integrar, verify sobre la rama del issue.
- `memory` (invocable por el modelo):
  - `decision` escribe `docs/decisions/AAAA-MM-DD-<slug>.md` con Qué, Por qué y Alternativa descartada.
  - `gotcha` agrega `- AAAA-MM-DD · <ws> · síntoma → causa → qué hacer` a `docs/gotchas.md`.
  - `recall` busca con Grep en esos archivos y en graphify.
  - Avisa si la ruta está ignorada por git, como `docs/` en api-academico.
- `sync` (`disable-model-invocation`): sigue estos pasos:
  - Precondiciones.
  - Respaldo `respaldo/<rama>-<AAAAMMDD-HHMM>`.
  - `fetch` y `merge origin/<rama>`, sin squash ni rebase.
  - `merged-files`.
  - verify.
  - Reporte con la vuelta atrás, que corre la persona.
- `agents/dev.md` (sonnet, Read/Write/Edit/Bash/Glob/Grep):
  - Lee `CLAUDE.md`, las rules y el manifiesto, y no escribe tests.
  - Corre typecheck una vez y lint de sus archivos al final.
  - Devuelve seis secciones: Contrato resultante, Archivos tocados, Desviaciones, Cobertura con `archivo:línea`, Riesgo y Pendiente para verify.

### §7, worktrees

- Punto 3: el registro quedó como en §6.1 de estas notas.
- Punto 4: `integrate` hace merge, borrado y cierre en un paso, y verify corre después sobre la rama del issue. Borrar antes de verificar no pierde nada, porque los commits ya están en la rama del issue.
- Punto 5, los cuatro cercos:
  - Stop (b): hecho.
  - SessionStart: hecho.
  - ship: lo cablea la fase 3a con `worktree-ledger.js pending --target <rama>`, que sale con 1 si hay abiertos.
  - Borrar worktree: hecho, por el ledger en `ExitWorktree` y en el guard.
- Punto 7: `SessionStart` solo avisa y nunca corre `git worktree prune`, porque un hook no escribe en git. `integrate` y `close` hacen `prune` cuando la carpeta del worktree ya no existe.
- Punto 8, `.worktreeinclude`: no se hizo. Los worktrees que abre el ledger no copian `.env` ni enlazan `node_modules`: para verificar dentro de uno hay que instalar dependencias. Va con los templates de la fase 6.

### §10 y §12

- Fase 3, mitad b: plan, build, worktree, memory, sync, el agente dev, los cercos de §7 y la mejora 3 del aviso de sesión concurrente. La salida de la fase 3 (un issue real de punta a punta sin invocar comandos) se prueba después del merge con la 3a.
- Decisiones tomadas en esta fase:
  - Los worktrees del ledger viven bajo `.tmp/harness/worktrees/`.
  - El Stop (b) solo bloquea un turno que sumó commits, como (a).
  - Integrar borra antes de verify.

### Hallazgos de la prueba sobre el clon (2026-10-19 y 20)

La prueba corrió sobre un clon de `api-academico`, en la rama `feature/crud-talleres` creada desde `feature/colegio-convenio-permissions`, contra un origin bare en `.tmp`. Las skills las ejecutó la sesión siguiendo su texto, y los hooks corrieron por stdin con el `cwd` del clon. Los hallazgos van a §3 o al adoptar api-academico, no al código del arnés:
- `main` de api-academico no tiene `CLAUDE.md` ni `.claude/rules` en la raíz: viven en las ramas de trabajo. Un issue que nace de `main` no ve las convenciones.
- En esa rama, `.gitignore` ignora `docs`. Las decisiones que escribe memory no se versionan sin `git add -f`, aunque `docs/decisions/0001-…` sí está trackeado de antes. memory lo avisa, y adoptar el repo debería quitar `docs` del `.gitignore`.
- El eslint de api-academico no cubre `scripts/*.js`: todo archivo ahí falla con `was not found by the project service`. Es un error previo, que en verify y en sync aparece como lint rojo de un archivo que entró.
- El issue pedía "solo ADMIN y COORDINADOR". El plan lo tradujo a permisos `taller.*` más los otorgamientos en el mantenedor de roles, porque las rules del repo prohíben comparar nombres de rol: eso salió como pregunta cerrada (P3). `coordinador` existe como rol de datos (`acl_rol`), no como constante `ACL_ROL_*`.
- El dev movió `TallerRepository` a `PersistenciaModule` (regla §7 del repo). Es un error de DI que no detectan ni tsc ni jest: hace falta `npm run start` con base de datos, y el arnés no lo corre.

## Para CHANGELOG.md

En la entrada de la versión que salga con la fase 3, sin cambiar la versión desde esta rama.

### Añadido
- Skills `plan` y `build` (invocables por el modelo), `worktree` y `sync` (solo la persona) y `memory` (invocable por el modelo).
- Agente `dev` (sonnet): implementa un workspace siguiendo su `CLAUDE.md` y sus rules, sin tests, y devuelve contrato, archivos, desviaciones, cobertura con `archivo:línea`, riesgo y pendientes.
- `worktree-ledger.js`: worktrees por tarea en `wt/<rama-issue>/<slug>` desde la rama del issue, con registro en `.tmp/harness/worktrees.json`; integrate con `merge --no-ff`, nunca squash, y close solo sin commits propios. pending sale con 1 si queda algo abierto.
- `merged-files.js`: lo que tocaron los dos lados de un merge y lo que entró.
- `SessionEnd` en `hooks.json`: suelta el lock de la sesión.
- Tests sobre repos de juguete, entre ellos una carpeta de dos repos: el ledger, merged-files, la sesión concurrente, los worktrees en SessionStart y en el Stop, el destino del ledger en ExitWorktree y en el guard, y la lectura de secretos por shell.
- `docs/PRUEBA-FASE-3B.md` con la prueba manual.

### Cambiado
- `session-start` lista los worktrees sin integrar y avisa de los de más de 7 días sin commits nuevos. Además avisa si otra sesión de Claude está activa en el mismo proyecto, con un lock propio en `.tmp/harness/sessions`, y le pide a la segunda que trabaje en un worktree.
- `stop-gate` hace efectiva la condición (b): bloquea una vez el turno que dejó commits sin integrar en un worktree del issue.
- `worktree-remove` y el guard miden los commits sin integrar contra la rama destino registrada en el ledger.
- El guard deniega `cat`, `type`, `Get-Content` y `head` de archivos de secretos, juzgando solo los archivos que leen. `read-guard.js` exporta `secretPath`.
- El protocolo que inyecta `session-start` nombra la lectura de secretos por shell entre lo denegado siempre.

## Para README.md

- Estado: fase 3, con plan, build, worktrees, memoria y sync en la rama 3b; verify, review y ship en la 3a.
- Permisos recomendados: `graphify query`, `explain` y `path` (`Bash(graphify query *)` y los otros dos), `Bash(glab issue view *)` y `Bash(gh issue view *)`. Los scripts nuevos ya los cubre la regla de `node` sobre la carpeta del plugin.
- Matriz: una fila para el tag de la fase 3 cuando se cierre.

## Schema y manifiesto

No hizo falta ningún campo nuevo. El ledger usa `defaultBranch`, y la skill worktree usa `integration.branchPrefix`, que ya existe. memory usa `memory.notes` y `memory.gotchas`, que ya existen, con sus valores por defecto.

## Archivos fuera del reparto explícito que se tocaron

Ninguno es de la mitad 3a, pero conviene mirarlos al mergear:
- `plugins/arnes/hooks/hooks.json`: la entrada `SessionEnd`.
- `plugins/arnes/tests/hooks-json.test.js`: espera `SessionEnd` y `session-start.js` dos veces.
- `plugins/arnes/scripts/hooks/read-guard.js`: exporta `secretPath` y corrige el comentario del `cat .env`.

## Para la fase 3a al mergear

- `ship` consulta `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree-ledger.js" pending --target <rama del issue>`. Si sale con 1, se niega, y muestra la salida, que trae una línea por worktree abierto.
- `worktree`, `sync` y `build` nombran "la skill verify". Si verify cambia de nombre o de argumentos, hay que ajustar esas tres.
- `lib/branches.js` todavía dice "Cuando exista el ledger de worktrees (fase 3), el destino pasa a ser la rama registrada en él". Ya existe: el destino del ledger lo resuelven `worktree-remove.js` (`targetsOf`) y el guard, y `branches.js` no cambia. El comentario hay que actualizarlo; no se tocó porque no estaba en el reparto.
- `arnes-ui` todavía no lee `.tmp/harness/worktrees.json`, aunque §6.5b lo lista ("2 wt sin integrar"). El formato quedó arriba.
