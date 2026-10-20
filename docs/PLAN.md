# Plan: arnés multi-proyecto para Claude Code

Fecha: 2026-10-19. Estado: plan aprobado en conversación, sin código aún.
Primer caso real: la carpeta `academico` (tres repos, tres stacks, raíz sin git). En las guías de prueba, `$PDV` es la carpeta que la contiene junto a `agentic-harness`.
Segundo caso: `renova365` (dos repos, raíz sin git), absorbiendo su `.claude/` actual y el fork de `api-academico/.claude/`.

## 1. Objetivo

Un plugin de Claude Code, versionado en su propio repo, que haga que cualquier sesión en cualquier proyecto trabaje con el mismo flujo (plan → build → verify → review → ship) sin invocar comandos, con verificación determinista, memoria compartida por el equipo y una capa humana obligatoria en zonas de riesgo. Pensado para un equipo donde los desarrolladores de front también harán back.

## 2. Principios (van en el README del repo, antes de cualquier código)

1. Cada pieza existe porque el modelo no lo hace solo. Cuando un modelo nuevo lo haga, la pieza se quita.
2. Lo que debe cumplirse siempre va a una herramienta (lint, tsc, tests, hook, CI, aprobación en el host git). Lo que requiere juicio va en prosa corta. Lo demás se borra.
3. Nada del stack queda cableado en el arnés: todo lo específico se lee del manifiesto del proyecto y de su `CLAUDE.md`.
4. El verde del arnés significa "cumple convenciones y compila/testea", nunca "es correcto en el negocio". Se dice así en cada reporte.
5. El plugin funciona completo sin el mod. El mod es opcional y delgado.
6. Presupuesto: ninguna skill supera ~80 líneas; ningún agente supera ~120; el `CLAUDE.md` raíz de un proyecto no supera 200.

## 3. Arquitectura en capas

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Transversal | repo `agentic-harness` (marketplace + plugins) | skills, agentes, scripts genéricos, hooks clásicos, mod |
| Proyecto | cada repo: `.claude/harness.json`, `CLAUDE.md`, `.claude/rules/`, lint y tests mecánicos | manifiesto, convenciones del stack, reglas con `paths:` |
| Carpeta multi-repo | repo-workspace diminuto por carpeta (`<carpeta>-workspace`) | `CLAUDE.md` raíz, `.claude/harness.json` como composición de los repos (§5.2), `.gitignore` de los repos, `setup` (fase 6) |
| Fuera de Claude | GitLab / Bitbucket | CI que corre los mismos scripts del gate; aprobación obligatoria en rutas de riesgo; main protegida |

Hechos verificados que condicionan el diseño (docs oficiales 2026-10):
- `.claude/settings.json` (hooks, permisos) se lee solo del directorio de arranque; no se hereda de padres. Agentes y skills se descubren subiendo desde cwd hasta la raíz del repositorio. Solo `CLAUDE.md` se hereda de todos los ancestros. Por eso lo transversal va en plugin, no en una carpeta padre.
- Un plugin habilitado a nivel de usuario carga en todos los proyectos. Skills y agentes de plugin llevan prefijo `<plugin>:`. Hooks de plugin no tienen prefijo: un hook duplicado en settings y en plugin corre dos veces.
- Hooks clásicos: `SessionStart` y `UserPromptSubmit` inyectan `additionalContext` (tope 10.000 chars); `PostToolUse` devuelve contexto o bloquea; `PreToolUse` deniega/reescribe input; `Stop` impide terminar el turno con `decision: block` + `reason` (tiene tope de bloqueos consecutivos: necesita condición de salida); existen `WorktreeCreate` y `WorktreeRemove`, pero `WorktreeRemove` solo se dispara para worktrees que creó un hook `WorktreeCreate` (verificado en la fase 2, ver §6.2). `SessionStart` solo admite `command` y `mcp_tool`.
- Mods (module de function hooks): `prompt.compose` añade secciones al system prompt en cada request; `tool.call` envuelve cualquier herramienta antes y después; `turn.complete` NO bloquea (devuelve `{text}`), pero `classic.Stop` sí es hookeable; `$.agent.register`/`$.agent.spawn` lanzan subagentes desde código; `$.ui` dibuja panel/estado/toasts; `$.model.complete` para clasificaciones baratas. Solo cargan en sesiones locales.
- Worktrees: los de subagentes nacen del branch por defecto salvo `worktree.baseRef: "head"`; se borran solos si no hay cambios y se quedan si los hay; nadie mergea de vuelta automáticamente. En Windows, borrar un worktree no borra lo que apuntan los links. Plugins a nivel de proyecto cargan también en los worktrees.
- Dentro de un worktree, `${CLAUDE_PROJECT_DIR}` de los hooks sigue apuntando al checkout principal; el campo `cwd` del JSON de entrada del hook es el que sigue a Claude. Por eso `lib/manifest.js` resuelve el manifiesto subiendo desde `cwd`, nunca desde `CLAUDE_PROJECT_DIR`.
- El hook `Stop` recibe `stop_hook_active: true` cuando el turno ya continúa por un bloqueo anterior: esa es la condición de salida documentada, no un contador propio. `SubagentStop` es un evento distinto y no se engancha: el gate es del hilo principal.
- Verificado en la fase 0 (2026-10-19): el CLI carga como agente cualquier `.md` dentro de `agents/`, así que esa carpeta no lleva `README.md` (se usa `README.txt`); la forma corta `owner/repo#ref` del comando de instalación siempre apunta a github.com, y en GitLab va la URL completa de clonado; `git mv` solo se registra como rename y el MR solo tiene base si existe un commit inicial en `main` antes de ramificar. Además, los usuarios reciben una versión nueva solo cuando cambia `version` en `plugin.json`: pushear sin subirla no llega a nadie, y `version` no se declara también en la entrada del marketplace porque `plugin.json` gana y `validate` avisa del desfase.
- Verificado en la prueba manual de la fase 2 (2026-10-19): los hooks del `.claude/settings.json` de un repo corren además de los del plugin, y basta que uno deniegue para que la llamada no corra. Un repo que conserva hooks del arnés anterior en su `.claude/settings.json` tiene dos guardias peleando. En `api-academico`, con bandera vigente, el guard del plugin dejó pasar `git commit --dry-run`, y el `.claude/hooks/git-guard.js` viejo lo negó porque exige un `gate-status.json` que ya no existe. Por eso adoptar un repo empieza por quitarlos (§8). Están en ese caso `api-academico`, en el `.claude/settings.json` del repo, y renova365, en el `.claude/settings.json` de la carpeta, que no es repo.
- Verificado en los tipos de la API de mods de 2.1.303 (2026-10-19, fase 2b):
  - `process.spawn` solo transmite la salida de los procesos que un plugin lanza con `$.process.spawn`. El Bash del modelo no pasa por ese evento, y los hooks del arnés son comandos clásicos. La salida de un Bash llega entera al cerrar su `tool.call` (`stdout`, `stderr`, `isError`), sin código de salida. Por eso `arnes-ui` muestra el progreso de una verificación como tiempo transcurrido, y no engancha `process.spawn`.
  - `turn.complete.usage` llega una vez por turno, en tokens. Un turno del hilo principal que pasa por varias etapas no se puede repartir entre ellas, y los tokens de modelos distintos no se comparan. `$.session.usage()` devuelve `cost.usd`, el total de `/cost`. El costo por etapa es la diferencia de ese total entre el inicio y el fin de la etapa, y `turn.complete.usage` queda para los tokens de cada agente.
  - Un comando que registra `$.command.register` se corre como `/<name>`, sin prefijo de plugin y sin dos puntos en el nombre. Por eso el panel se abre con `/arnes-panel`, y no con `/arnes-ui:panel`.
  - Un mod no tiene `require` ni conoce la carpeta de otro plugin: `$.plugin.root` es la suya. No puede correr `gate-flag check` ni calcular el hash de los tocados. `arnes-ui` muestra de la bandera el resultado, la edad y si cambió el HEAD, y la da por vencida si un archivo cambiado se modificó después. La vigencia exacta la siguen juzgando el guard y el `Stop`.
- Verificado en la prueba manual de la fase 2b (2026-10-19, Claude Code 2.1.304):
  - Un hook de mod en `classic.Stop` puede no correr nunca. El transcript dijo `arnes-ui: its classic.Stop hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`: un plugin interno del CLI está antes en la cadena y pasa el evento por encima de los mods. Por eso el aviso de Stop bloqueado no se engancha al Stop. El `stop-gate` anota cada bloqueo en la timeline (nota `bloqueado`), y `arnes-ui` levanta el aviso cuando lee esa nota con su reloj.
  - Que un toast se vea depende de la superficie. En la terminal embebida de Muxentra dentro de VS Code no se vio ningún toast de `arnes-ui`, mientras que la banda, el panel y `$.ui.log` sí se vieron. `$.ui.toast` no dice si se dibujó. Por eso los avisos que importan (Stop bloqueado, gate en rojo, zona de riesgo, compactación) van también al transcript con `$.ui.log`. El cambio de etapa queda solo en toast, porque la banda y la status line ya lo muestran.
  - La status line de un mod la etiqueta el motor: `$.ui.status("listo")` se dibuja como `⚠arnes-ui: listo`. El mod pasa solo el texto, sin prefijo propio.
- Verificado en la fase 3 (2026-10-19 y 20, Claude Code 2.1.304):
  - Lanzar `claude -p` desde una sesión depende de cómo la juzgue el modo de permisos. En la 3a, una sesión corrió `claude -p --plugin-dir` sobre el clon con el stream completo. En la 3b, desde una sesión en modo auto, el clasificador lo negó por considerarlo un desvío del modo auto, y las skills se ejecutaron siguiendo su texto. En el cierre, también en modo auto, corrió: la persona había pedido la prueba de punta a punta. La prueba que cierra la fase la hace la persona en una sesión real (`docs/PRUEBA-FASE-3.md`).
  - El `stream-json` de `claude -p` no trae los eventos de `PreToolUse`. Para ver qué decide el guard sobre un comando, se corre el hook por stdin con el mismo estado.
  - Claude Code pone `CLAUDE_PID` (su propio pid) en el entorno de los procesos que lanza. Se vio en el entorno del Bash del modelo, y el binario de 2.1.304 arma ese entorno junto con `CLAUDECODE` y `CLAUDE_CODE_SESSION_ID`. En `claude -p` llega también a los hooks: en la corrida de punta a punta del cierre, el lock de sesión traía el pid del `claude.exe` de la corrida. En una sesión interactiva también llega: en la prueba manual del 2026-10-20, el lock traía un pid numérico. Si alguna vez no llega, el lock de sesión queda sin pid y vale por su fecha (24 h), o hasta que su sesión lo suelta en `SessionEnd`.
  - El hook `skill.prompt` de un mod tampoco corre: el transcript dice `arnes-ui: its skill.prompt hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`, como con `classic.Stop` en la fase 2b. `arnes-ui` no ve la carga de las skills, y la banda no muestra las etapas que solo salen de ahí (Planeando, Entregando, Guardando memoria, Sincronizando). Las que salen de agentes y herramientas sí se ven. Corregido antes del piloto: la etapa de una skill sale de los `start` y `end` que anota en la timeline (§6.5b).

## 4. Estructura del repo `agentic-harness`

```
agentic-harness/
  .claude-plugin/marketplace.json        # lista tres plugins: arnes, arnes-ui, arnes-mod
  README.md                              # principios, instalación, permisos recomendados, matriz de compatibilidad
  CHANGELOG.md
  docs/PLAN.md                           # este plan, movido aquí en la fase 0
  templates/                             # lo que `arnes:init` copia a un proyecto o a un repo-workspace
    workspace/{CLAUDE.md,harness.json,setup.js,.gitignore,.worktreeinclude}
    ci/{gitlab-ci.yml,bitbucket-pipelines.yml}   # job `arnes-gate` + squash y pipeline obligatorio documentados
  plugins/
    arnes/
      .claude-plugin/plugin.json         # name: arnes, version semver
      schema/harness.schema.json         # JSON Schema de los dos niveles del manifiesto (repo y carpeta); lo usan init, adoption-check y lib/manifest.js
      skills/
        init/SKILL.md                    # genera y valida .claude/harness.json; --check = mínimo de adopción
        plan/SKILL.md                    # criterios + contrato + riesgo → .tmp/harness/plan.md
        build/SKILL.md                   # dev genérico por workspace, orden back → front
        verify/SKILL.md                  # typecheck/lint/tests filtrados; escribe bandera de verificación
        review/SKILL.md                  # reviewer aparte; marca zonas de riesgo
        ship/SKILL.md                    # rama, commit, push, MR/PR cruzados; rechaza con worktrees abiertos
        worktree/SKILL.md                # abrir/integrar/cerrar worktrees por issue (ver §7)
        memory/SKILL.md                  # escribe decisión/gotcha en docs/ del repo; consulta graphify
        sync/SKILL.md                    # traer main a la rama, por workspace, con respaldo (versión corta del sync-branch actual)
        timeline/SKILL.md                # imprime .tmp/harness/timeline.jsonl como texto; funciona sin el mod
      agents/                            # ojo: el CLI carga como agente TODO .md de esta carpeta; nada de README.md aquí (README.txt o nada)
        dev.md                           # sonnet; lee CLAUDE.md del workspace; no escribe tests
        reviewer.md                      # opus; solo lectura; lista cerrada + cumplimiento de criterios + riesgo
        test-writer.md                   # sonnet; contra el estándar de tests del repo
        test-runner.md                   # haiku; corre y reporta; separa preexistentes
      hooks/hooks.json                   # hooks clásicos, todos `node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<x>.js"` (ruta entre comillas: en Windows la caché puede tener espacios)
      scripts/
        lib/manifest.js                  # busca harness.json subiendo desde el `cwd` del hook; compone repo + carpeta (§5); valida contra el schema; resuelve workspace por ruta
        lib/timeline.js                  # append de etapas a .tmp/harness/timeline.jsonl (inicio, fin, resultado)
        lib/glob.js                      # globs → RegExp, sin dependencias
        lib/exec.js                      # git y comandos del manifiesto, con {files}/{specs} citados y partidos si exceden la línea
        lib/hook.js                      # stdin/stdout de los hooks; un error propio sale con 0 y nunca bloquea
        lib/shell.js                     # segmentos de un comando Bash/PowerShell sin heredocs ni here-strings; ejecutable de cada uno
        lib/branches.js                  # commits de una rama fuera de la rama por defecto (branch -D, worktrees)
        init-draft.js                    # detección determinista de arnes:init: repos, stack, comandos, specPattern; escribe los dos niveles de §5
        touched-files.js                 # modificados + untracked por workspace
        typecheck-baseline.js            # foto y diff por diagnóstico (parser tsc; interfaz para otros)
        test-select.js                   # deriva specs de archivos tocados según specPattern
        merged-files.js                  # intersección real tras un merge
        worktree-ledger.js               # registro de worktrees por issue; pendientes de integrar
        gate-flag.js                     # escribe/valida la bandera de verificación
        test-baseline.js                 # línea base de tests commiteada: capture y check (§6.1)
        review.js                        # entrada del reviewer sin Bash y marca de revisión hecha
        ship.js                          # check, rama y stage de ship
        adoption-check.js                # las 8 comprobaciones del mínimo
        ci-gate.js                       # lo que corre el CI: touched-files + typecheck + lint + test-select sobre el MR
        hooks/{session-start,prompt-context,after-edit,guard,read-guard,stop-gate,worktree-remove}.js   # session-start atiende también SessionEnd
      tests/                             # repos de juguete + node --test; corre en CI del arnés
    arnes-ui/
      .claude-plugin/plugin.json         # solo interfaz: banda, panel, status, toasts (§6.5b)
      hooks/hooks.json                   # { "modules": ["./register.tsx"] }
      hooks/register.tsx                 # hooks y dibujo (≤ 300 líneas)
      hooks/lib.ts                       # lo puro: rutas, globs, formatos, comandos y git
      types/index.d.ts                   # contrato de $.state
      tests/arnes-ui.test.ts             # claude plugin test
    arnes-mod/
      .claude-plugin/plugin.json         # comportamiento: depende de arnes
      hooks/hooks.json                   # { "modules": ["./register.ts"] }
      hooks/register.ts                  # prompt.compose + reviewer determinista
      types/index.d.ts
  .gitlab-ci.yml / .github/workflows     # validate + tests + plugin test contra versión fijada del CLI
```

Todo en Node (sin bash, sin jq): el equipo está en Windows y los hooks tienen que correr igual en PowerShell, Git Bash y CI.

Cambio de la fase 3 (2026-10-20): `hooks/hooks.json` suma `SessionEnd`, que corre `session-start.js`. Ese script atiende los dos eventos: al arrancar escribe el lock de la sesión, y al cerrar lo borra. No hay script de hooks nuevo. `merged-files.js` y `worktree-ledger.js`, que ya estaban en el árbol, existen desde la fase 3.

Política de invocación de las skills (es el mecanismo de "se comporta sin invocarlo"): `plan`, `build`, `verify`, `review`, `memory` y `timeline` quedan invocables por el modelo (sin `disable-model-invocation`), con descripciones que empiezan por las palabras de un pedido real ("implementar", "corregir", "revisar"); `init`, `ship`, `worktree` y `sync` llevan `disable-model-invocation: true` porque mueven ramas o crean archivos y las dispara solo la persona. Los agentes del plugin ignoran `hooks`, `mcpServers` y `permissionMode` en su frontmatter (restricción documentada de los plugins), así que todo control sobre ellos va por los hooks del plugin, no por el agente.

## 5. Manifiestos: uno por repo, y una composición por carpeta multi-repo

Cambio de la fase 1 (2026-10-19): la unidad del manifiesto es el repo. Antes había un solo `.claude/harness.json` por carpeta con todos los comandos, y el CI de cada repo (que clona solo ese repo) no podía verlo. Ahora cada repo lleva el suyo con sus comandos, que es el que lee `ci-gate` en el pipeline, y el de la carpeta es una composición que apunta a ellos y agrega solo lo que existe entre repos. Nada se duplica.

### 5.1 Manifiesto de repo: `<repo>/.claude/harness.json`

```json
{
  "version": 1,
  "name": "api-academico",
  "workspaces": [
    {
      "name": "api",
      "path": ".",
      "git": ".",
      "remote": "gitlab.com/preupdv/apps/api-academico",
      "defaultBranch": "main",
      "stack": "nestjs-prisma",
      "commands": {
        "typecheck": ["npx tsc --noEmit"],
        "lint": "npx eslint {files} --max-warnings=0 --no-warn-ignored",
        "test": "npx jest {specs} --runTestsByPath --verbose",
        "testAll": "npx jest",
        "build": "npm run build"
      },
      "specPattern": "{dir}/{name}.spec.ts",
      "riskPaths": ["prisma/migrations/**", "src/auth/**", "src/acl/**"],
      "forbidden": ["npm run lint", "npm run format", "prisma migrate reset"]
    }
  ],
  "memory": { "notes": "docs/decisions", "gotchas": "docs/gotchas.md", "graphify": true }
}
```

El front lleva el suyo con `"lint": "npx eslint {files} --max-warnings=0 --no-warn-ignored"` (Next 16 ya no trae `next lint`) y `"specPattern": ["{dir}/{name}.test.tsx", "{dir}/{name}.test.ts", "{dir}/__tests__/{name}.test.tsx"]`.

### 5.2 Composición de carpeta: `<carpeta>/.claude/harness.json`

```json
{
  "version": 1,
  "name": "academico",
  "repos": [
    { "path": "api-academico", "contract": { "provides": ["src/**/dto/**", "src/**/*.controller.ts"] } },
    { "path": "academico-front", "contract": { "consumes": ["src/**/types/**", "src/**/api/**"] } },
    { "path": "academicoBitbuckett" }
  ],
  "integration": { "branchPrefix": "feature/", "sameBranchAcrossWorkspaces": true }
}
```

### 5.3 Reglas

- Un manifiesto con `workspaces` es de repo; uno con `repos` es una composición. El schema acepta exactamente una de las dos formas.
- Manifiesto de repo: en una carpeta multi-repo lleva un solo workspace con `path: "."` y `git: "."`. Un monorepo de un solo repo con varios paquetes lleva varios workspaces, y `git` es la ruta del paquete a la raíz del repo (`".."`, `"../.."`). Un proyecto de un repo es solo esto, sin composición.
- Composición: lista los repos por `path`, relativo a la carpeta. Cada uno se lee de `<path>/.claude/harness.json` por convención. Solo agrega lo que existe entre repos: `integration` (la misma rama en todos) y `contract` (globs que cada repo provee o consume). El nombre y los comandos de cada workspace vienen del manifiesto del repo y no se repiten en la carpeta.
- Un repo listado sin manifiesto propio (hoy, el PHP de academico) es un workspace no adoptable todavía. Se declara solo con su repo y sin comandos. Los scripts lo ven, pero no lo verifican, y `adoption-check` lo reporta como no adoptable sin bloquear.
- Resolución: `lib/manifest.js` sube desde el `cwd` hasta el primer `.claude/harness.json`. Si es de repo, sigue subiendo por si una composición lo lista, y entonces la raíz del proyecto (donde vive `.tmp/harness/`) es la carpeta. Así una sesión abierta dentro de `api-academico/` sigue viendo a sus hermanos, y el pipeline, que no tiene carpeta encima, ve solo su repo.
- Rutas: el `path` de un workspace es relativo a la raíz de su repo. El `path` de un repo es relativo a la carpeta. Los globs (`riskPaths`, `sharedPaths`, `codeGlobs`, `contract`) son relativos al workspace. "Relativo al manifiesto" significa relativo a la carpeta que contiene `.claude/`, nunca al cwd.
- `{files}` y `{specs}` se sustituyen por listas citadas. `stack` es etiqueta informativa, nunca rama de código. `commands.typecheck` es lista porque Angular necesita dos tsconfig. Todo comando es opcional salvo `typecheck` o `test` (al menos uno): `client` de renova365 no tiene eslint y no se inventa.
- `specPattern` es un string o una lista, porque los repos reales mezclan formatos (renova api: `__test__/` y junto al archivo; front: `.test.tsx`, `.test.ts` y `__tests__/`). Placeholders:
  - `{dir}`: la carpeta del archivo, relativa al workspace.
  - `{ancestor}`: la carpeta del archivo o cualquiera de sus ancestros dentro del workspace; gana el más cercano donde exista el spec. Se necesita porque en renova api 1386 de 1564 specs de `__test__/` están en la raíz del módulo y no junto al archivo (`modulo/__test__/x.use-case.spec.ts` para `modulo/application/use-cases/x.use-case.ts`).
  - `{name}`: el nombre del archivo sin la última extensión.

Campos opcionales que los hooks consumen: `codeGlobs` (qué cuenta como "cambio de código" para el gate del `Stop`; por defecto `**/*.{ts,tsx,js,jsx,php,sql}` y nunca `*.md`), `sharedPaths` (rutas cuyo cambio obliga a suite completa), `commands.typecheckFast` (variante incremental para el hook de después de editar; si no existe, ese hook solo lintea el archivo y el typecheck completo corre en `verify`).

`arnes:init` (con `scripts/init-draft.js`) genera los dos niveles. Primero, el manifiesto de cada repo detectado, a partir de `package.json`, los tsconfigs, la configuración de eslint y los formatos de spec que aparecen en `git ls-files`. Un repo que solo tiene `composer.json` se declara sin manifiesto propio. Después, si la carpeta no es un repo y contiene repos anidados, la composición. Todo se valida contra `schema/harness.schema.json`, y el humano completa lo que no se infiere (`riskPaths`, `contract`, `sharedPaths`, `integration`, `memory`). `arnes:init --check` corre `adoption-check.js`. En academico la carpeta es a la vez el repo del arnés, así que su composición queda en `.gitignore`.

## 6. Componentes

### 6.1 Scripts (lo determinista)
- `touched-files.js`: por workspace, `git diff --name-only --diff-filter=d <base>` ∪ `git ls-files --others --exclude-standard`, con `-c core.quotePath=false`; salida prefijada; `--relative`, `--ext`.
- `typecheck-baseline.js capture|diff <ws> <ref> <foto>`: comanda lo que diga el manifiesto; parser de diagnósticos por herramienta (tsc primero; interfaz `parse(output) → [{file, code, msg}]`); clave sin línea/columna; conteos por clave; exit 0/1/2/3/4 como hoy. Se porta de renova365 con sus tests.
- `test-select.js`: de archivos tocados a specs usando `specPattern`; excepción "código compartido → suite completa" configurable por `sharedPaths`.
- `worktree-ledger.js open|integrate|close <slug> [--ws n]... [--issue ref] | list [--all] [--json] | pending [--target rama] [--json]` (§7, construido en la fase 3):
  - El registro es `<raíz>/.tmp/harness/worktrees.json` = `{ "version": 1, "worktrees": [ { ws, path, branch, target, issue, openedAt, status, closedAt?, merge? } ] }`, con `status` abierto, integrado o cerrado.
  - Cada worktree vive en `<raíz>/.tmp/harness/worktrees/<ws>/<slug>`. En una carpeta multi-repo eso queda fuera de los repos, y en un proyecto de un repo `touched-files` ya excluye `.tmp/harness/`. No se usa `.claude/worktrees/`, que es la carpeta de los worktrees propios de Claude Code.
  - `open` se niega desde la rama por defecto (`defaultBranch`, o main y master), con HEAD suelto, con slug inválido o con una rama que ya existe. Sin `--ws`, abre uno por repo adoptable: en un monorepo, uno por repo y no uno por paquete.
  - `integrate` se niega si el worktree tiene cambios sin commitear, si el checkout principal no está en la rama destino o si hay un merge a medias. Después hace `git merge --no-ff --no-edit` (nunca squash), borra el worktree y la rama con `branch -d`, y cierra el registro. Un conflicto deja el merge a medias y el registro abierto; resuelto y commiteado, otro `integrate` termina.
  - `close` cierra solo un worktree sin commits propios; con commits, se niega.
  - `pending` sale con 1 si queda algo abierto. Es lo que consultan `ship` y el `Stop`.
  - Desde dentro de un worktree, el registro es el del checkout principal (`git rev-parse --git-common-dir`). El estado del arnés que deja una sesión dentro del worktree (su `.tmp/harness/`) no cuenta como cambio sin commitear y se borra con él.
- `merged-files.js [--ws n]... [--ref commit] [--json]`: por workspace, `ambos` son los archivos que cambiaron los dos lados desde la base común, y `entró` son los que el merge cambió respecto del primer padre. Sale con 1 si el ref no es un merge, sea fast-forward o nada que traer.
- `gate-flag.js write <ws>` escribe `.tmp/harness/gate/<ws>.json` = `{ head, touchedHash, contentHash, result, at }`; `check <ws>` valida vigencia (mismo HEAD, mismo hash de la lista de tocados, mismo hash del contenido de cada tocado, trackeado o no, < 30 min). Cambio de la fase 2b (2026-10-19): la prueba manual mostró que editar un archivo ya tocado no vencía la bandera, y por eso entró `contentHash`. Sigue sin ser la huella del árbol entero (§11), solo de los tocados: el CI es quien garantiza la honestidad, no el marcador.
- `adoption-check.js`: manifiesto válido; `CLAUDE.md` presente; lint y typecheck ejecutables; CI con el job del gate; rutas de riesgo declaradas; versión del plugin fijada; ningún hook del `.claude/settings.json` de un repo o de la carpeta que corra scripts propios de `.claude/hooks/`; desde la fase 3, la línea base de tests válida y commiteada. Un repo de la composición sin manifiesto propio sale como "no adoptable todavía" y no bloquea.
- `ci-gate.js`: el base es `--base`, o `CI_MERGE_REQUEST_DIFF_BASE_SHA` en GitLab, o el merge-base con `origin/<defaultBranch>`. La foto de typecheck del base sale de `git archive <base>` a un directorio temporal, que no toca `.git` ni crea worktrees ni ramas, con el `node_modules` del workspace enlazado: symlink en CI (Linux), junction en Windows local, o copia si no se puede crear el enlace. Se compara contra el árbol actual con la misma clave y los mismos conteos que `typecheck-baseline`. Después corre lint sobre los tocados que caen en `codeGlobs` y los tests que elige `test-select`. Cambio de la fase 3 (2026-10-20): la foto del base se guarda en `.tmp/harness/typecheck/<ws>.txt`, con el formato de `typecheck-baseline` (`BASELINE: <hash>` y `TYPECHECK_EXIT`). Se reutiliza mientras su hash sea el del base y solo se captura cuando cambió. Una corrida que no llegó a correr no se guarda. Un cambio de `node_modules` con el mismo HEAD no la vence: borrar el archivo fuerza la captura. En CI, `.tmp` no persiste.
- Línea base de tests commiteada (mejora tomada de coding-agent-harness; se construye en la fase 3). `ci-gate` y `verify` comparan los totales de tests que pasan, fallan y se saltan contra una línea base commiteada en el repo: `tests/baseline.json`, o la ruta que fije el schema. Si el total cae por debajo de la base, el gate se pone rojo aunque lo que queda esté verde, porque un test borrado o saltado es una regresión silenciosa. Los saltos se declaran por nombre en la base. Un commit que cambia la base lleva el prefijo `gates:` en el asunto.
  Cambio de la fase 3a (2026-10-19): la base guarda los conteos por spec, no solo los totales, porque `verify` y `ci-gate` corren solo los specs de `test-select`. Se compara la suma de los specs que corrieron contra la suma de esos mismos specs en la base, y un spec de la base que ya no existe es rojo aunque no haya otro código tocado. El formato es `$defs.testBaselineFile` del schema y la ruta se cambia con `testBaseline` en el workspace. Las fallas preexistentes salen de `tests/known-failures.txt`, con una línea `AAAA-MM-DD | <spec> | <nombre completo>` por test: solo cuenta la coincidencia exacta, no ponen rojo y salen en el reporte con su fecha. Una línea sin fecha no absuelve.

### 6.2 Hooks clásicos (`hooks/hooks.json`)
| Evento | Script | Hace |
|---|---|---|
| `SessionStart` | `session-start.js` | Lee el manifiesto; imprime workspaces, rama de cada uno, árbol sucio, worktrees pendientes de integrar (§7), últimas 5 decisiones de `docs/decisions`; inyecta el protocolo en ≤ 40 líneas. Si no hay manifiesto, dice cómo crearlo y no inventa nada. Desde la fase 3: lista los worktrees abiertos del registro, cinco como máximo, con sus commits sin integrar, y a los de más de 7 días sin commits nuevos (desde el último commit propio de la rama, o desde que se abrió) les agrega `intégralo o ciérralo, nunca se borra solo`. Mejora 3: cada sesión escribe `.tmp/harness/sessions/<session_id>.json` = `{ pid, session, cwd, at }`, y si ve el lock de otra sesión viva (pid existente y menos de 24 h) avisa en la segunda línea que esta debe abrir su propio worktree (§7). Un lock con pid muerto, de más de 24 h o ilegible se borra; uno con el mismo pid es de la misma sesión tras un `/clear` y no avisa. No usa los archivos de sesión del CLI, solo el lock propio. Sin manifiesto no hay lock, y una sesión dentro de un worktree escribe el suyo en el `.tmp/harness` del worktree, así que no avisa por la del checkout principal. El protocolo nombra las skills: verificar es `/arnes:verify`, revisar es `/arnes:review` e integrar es `/arnes:worktree integrate <slug>`, y nunca manda a escribir la bandera a mano |
| `SessionEnd` | `session-start.js` | Borra el lock de la propia sesión. Desde la fase 3 |
| `UserPromptSubmit` | `prompt-context.js` | Adjunta estado corto (rutas de riesgo tocadas, bandera vigente o no). Nunca bloquea |
| `PostToolUse` (`Edit\|Write`) | `after-edit.js` | Lintea solo el archivo editado (segundos) y devuelve los hallazgos como `additionalContext`. Corre typecheck solo si el workspace declara `commands.typecheckFast` (incremental), con debounce de 20 s por workspace; sin esa variante, el typecheck completo se deja para `verify`, porque un `tsc` de un minuto tras cada edición destruye la sesión. Nunca bloquea |
| `PreToolUse` (`Bash\|PowerShell`) | `guard.js` | Parsea el comando por segmentos (`&&`, `;`, `\|`, saltos) y solo juzga segmentos que empiezan por el ejecutable. Deniega siempre, haya o no manifiesto: `git reset --hard`, `push --force`, `clean -f`, `branch -D` de ramas con commits sin mergear y `git worktree remove` de un worktree con commits sin integrar. Con manifiesto, además: comandos de `forbidden`; `git commit` sin bandera vigente para ese workspace; `git add .` con `.env`/logs sin trackear. Desde la fase 3, `branch -D` y `git worktree remove` miden contra la rama destino registrada en el ledger cuando la rama o la carpeta están abiertas en él, y si no contra la rama por defecto. También deniega siempre `cat`, `type`, `Get-Content`, `gc` y `head` sobre los mismos archivos de secretos que `read-guard.js`, más los `secretPaths` del manifiesto: juzga solo los archivos que leen, no las opciones, ni el destino de `>` o `>>`, ni el marcador de heredoc, así que `cat > .env <<EOF` pasa y `cat < .env` se deniega. Nunca mira texto de heredocs ni argumentos de `echo`; de `cat`, `type`, `Get-Content` y `head` mira solo los archivos que leen |
| `Stop` | `stop-gate.js` | Bloquea terminar si (a) hay cambios en archivos de `codeGlobs` sin bandera de verificación vigente, o (b) hay worktrees del issue con commits sin integrar. Un solo bloqueo por turno: si la entrada trae `stop_hook_active: true`, deja pasar con aviso visible y escribe el pendiente en la timeline. Cada bloqueo también queda en la timeline (nota `bloqueado`), que es de donde `arnes-ui` saca su aviso. Solo bloquea un turno que cambió algo: `prompt-context` deja en cada prompt una foto de la lista y del contenido de los tocados (`.tmp/harness/turn.json`), y si al cerrar el turno nada cambió respecto de esa foto, el `Stop` solo avisa con `systemMessage`. Sin foto bloquea. No engancha `SubagentStop`. No bloquea si no hay manifiesto. Condición (b), desde la fase 3: "del issue" son los registros abiertos cuyo destino es la rama en que está el checkout principal de su workspace; bloquea si alguno tiene commits sin integrar y el último es posterior a la foto del turno, con un segundo de margen porque git guarda la fecha en segundos, y si son de un turno anterior solo avisa, como (a). Una sesión dentro de un worktree no juzga (b): integrar le toca a la del checkout principal. Con (a) y (b) a la vez el bloqueo es uno solo y nombra las dos cosas (nota `turno bloqueado sin verificar: …; sin integrar: …`). El motivo nombra las skills: verificar es `/arnes:verify` e integrar es `/arnes:worktree integrate <slug>`, que corre la persona |
| `PreToolUse` (`ExitWorktree`) | `worktree-remove.js` | Deniega `action: "remove"` si la rama del worktree tiene commits no contenidos en su rama destino: la registrada en el ledger si la rama o la carpeta están abiertas en él, y si no la rama por defecto del workspace. Un worktree integrado en la rama del issue y todavía no en main ya se puede borrar. `git worktree remove` por shell lo cubre `guard.js` con la misma regla |
| `PreToolUse` (`Read\|Glob\|Grep`) | `read-guard.js` | Deniega abrir o buscar en archivos de secretos, para que nunca entren al transcript. La lista fija cubre `.env` y variantes (salvo `.env.example`), lo que esté dentro de `~/.ssh` y `~/.aws`, credenciales, tokens y llaves privadas; `secretPaths` del manifiesto la amplía por workspace. Aplica siempre, haya o no manifiesto, como las reglas destructivas de git. Read se juzga por `file_path`, Glob por `path` y `pattern`, y Grep por `path` y `glob`. Un Grep sobre una carpeta entera no se deniega (ripgrep salta lo ignorado), y un `cat .env` por Bash lo juzga el guard. Mejora 2, construida con las correcciones de la fase 2b |

Cambio de la fase 2 (2026-10-19): `WorktreeRemove` no sirve para este rechazo. Según la documentación de 2.1.303, ese evento solo se dispara para worktrees creados por un hook `WorktreeCreate` propio, y un hook que sale con 0 cuenta como si hubiera borrado el directorio. Los worktrees de git, que son los del §7, los borra Claude Code sin pasar por él. Los dos caminos reales para que un agente borre un worktree son la herramienta `ExitWorktree` (exige `discard_changes: true` con commits sin mergear, pero el modelo puede pasarlo) y `git worktree remove` por shell, y los dos pasan por `PreToolUse`.

### 6.3 Skills (lo que requiere juicio, corto)
- `plan`: lee el issue (gh/glab o texto), consulta graphify si existe (`/graphify query`) en vez de barrer el repo, produce `.tmp/harness/plan.md` con: criterios literales e inferidos, contrato (ruta, request, response, roles), tablas y migraciones, zonas de riesgo tocadas, preguntas cerradas con recomendación. Pide confirmación. Escrito para que lo apruebe alguien que no conoce el stack.
- `build`: un `dev` por workspace, back antes que front; el contrato del back viaja textual al front; desviaciones del plan declaradas.
- `verify`: scripts del §6.1 sobre los workspaces tocados; `test-writer` solo si hay código nuevo sin spec; escribe la bandera. Reporta "verde = compila y testea".
- `review`: `reviewer` una vez sobre el árbol final, con el plan y la lista de tocados; sección de cumplimiento de criterios; si toca `riskPaths`, marca `REVISIÓN HUMANA OBLIGATORIA` en el reporte y en el cuerpo del MR.
- `ship`: misma rama en todos los workspaces tocados, commits back → front, push y MR/PR cruzados; se niega si el ledger tiene worktrees abiertos del issue; convención de commits del repo (lee `commitlint`/`CLAUDE.md`).
- Cambio de la fase 3a (2026-10-19):
  - `verify` corre `ci-gate.js --ws <ws> --base HEAD` por workspace tocado: el mismo motor que el CI, sobre los cambios sin commitear. La foto del HEAD sale de `git archive`, con la clave y los conteos de `typecheck-baseline`, y desde el cierre de la fase 3 se reutiliza mientras el HEAD no cambie (§6.1).
  - "Código nuevo sin spec" son los archivos agregados o sin trackear sin spec (`test-select --missing`).
  - `review` prepara con `review.js input` lo que el reviewer, sin Bash, no puede sacar: el diff contra HEAD, los tocados, las riskPaths tocadas y las reglas. Después marca la revisión con la misma huella de la bandera.
  - `ship` exige la revisión del árbol actual y sin bloqueantes, y hace un solo commit por workspace, porque el guard pide bandera vigente en cada commit y el primero cambia el HEAD. Se niega con worktrees abiertos del issue: `ship.js check` consulta el registro con la rama actual de cada workspace, y la skill corre `worktree-ledger.js pending --target <rama>` con la rama que va a usar.
- Cambio de la fase 3b (2026-10-19 y 20). Tamaños: plan 42 líneas, build 33, worktree 46, memory 52 y sync 34.
  - `plan` (invocable por el modelo):
    - Lee el issue con glab o gh según el remote, o toma el texto. Consulta graphify con `graphify query`, `explain` y `path` si existen `graphify-out/graph.json` y el comando `graphify`.
    - Escribe `plan.md` con título, Issue, Criterios `[literal]` o `[inferido]`, Contrato de API, Datos, Workspaces y orden, Archivos previstos, Zonas de riesgo, Preguntas y Fuera de alcance. Cada pregunta lleva Recomendación y Alternativa. Archivos previstos no estaba en este párrafo: hace falta para cotejar `riskPaths`.
    - Pide confirmación. Con la respuesta, escribe `Aprobado:` y la sección `## Decisiones`.
  - `build` (invocable por el modelo):
    - Exige `Aprobado:` en el plan. Lanza un `arnes:dev` por workspace, primero el back. El contrato va textual entre `--- contrato del back ---` y `--- fin del contrato ---`.
    - Comprueba las seis secciones del reporte y abre dos o tres líneas citadas. Relanza el dev una vez si falta un criterio.
    - Anota la timeline por workspace (`start` y `end build --ws`): una entrada global además de las de cada workspace duplicaría el total por etapa de `timeline print`.
    - Si dos devs tocarían los mismos archivos a la vez, le pide a la persona `/arnes:worktree open <slug>`.
  - `worktree` (`disable-model-invocation`): open, integrate, close, list y pending sobre `worktree-ledger.js`. Después de integrar, verify sobre la rama del issue.
  - `memory` (invocable por el modelo):
    - `decision` escribe `docs/decisions/AAAA-MM-DD-<slug>.md` con Qué, Por qué y Alternativa descartada.
    - `gotcha` agrega `- AAAA-MM-DD · <ws> · síntoma → causa → qué hacer` a `docs/gotchas.md`.
    - `recall` busca con Grep en esos archivos y en graphify.
    - Avisa si la ruta está ignorada por git, como `docs/` en api-academico.
  - `sync` (`disable-model-invocation`): precondiciones; respaldo `respaldo/<rama>-<AAAAMMDD-HHMM>`; `fetch` y `merge origin/<rama>`, sin squash ni rebase; `merged-files`; verify; y un reporte con la vuelta atrás, que corre la persona.
- `worktree`: §7.
- `memory`: `decision` escribe `docs/decisions/YYYY-MM-DD-<slug>.md` (qué, por qué, alternativa descartada); `gotcha` añade a `docs/gotchas.md`; `recall` consulta esos archivos y graphify. Sin MCP.
- `sync`: versión de 60 líneas del `sync-branch` actual: respaldo, fetch, merge contra `origin/<rama>`, `merged-files`, verify.
- `timeline`: imprime `.tmp/harness/timeline.jsonl` como texto, con duración por etapa. Cada skill anota su inicio y su fin con `lib/timeline.js`, así la medición existe aunque `arnes-ui` no esté instalado (CI, otra máquina, sesión sin mods); el mod solo la dibuja.
- Cambio antes del piloto (2026-10-20), por la prueba manual de la fase 3:
  - `plan` y `build` llevan la línea de verify, review y ship: cada comando se corre solo, sin `&&`, `;` ni `echo`, porque un comando encadenado pide permiso aparte. En la corrida automática, plan corrió `cd … && node … ; echo "---"; node …`. Un test comprueba la línea en las cinco skills del flujo.
  - `plan` cierra su etapa cuando el plan está escrito (`end plan --result ok --detail "plan escrito"`) y deja la nota `esperando` hasta la respuesta de la persona. Con la respuesta anota `aprobado` o `cancelado`. Si pide cambios, abre otra vez la etapa con `start plan --detail "ajuste"`, y al terminar el ajuste vuelve a cerrar y a esperar. En la prueba manual, plan midió 16m01s porque la etapa cerraba con la aprobación, y la espera del humano contaba como plan. `timeline.js` admite `note` desde la línea de comandos, y `print` le pone al evento que sigue a una nota `esperando` la duración de la espera, suma aparte `espera de la persona: …` y lista lo que sigue esperando.

### 6.4 Agentes
`dev` (sonnet, Read/Write/Edit/Bash/Glob/Grep; lee `CLAUDE.md` y rules del workspace; no escribe tests; devuelve contrato resultante y criterios cubiertos con `archivo:línea`), `reviewer` (opus, solo lectura con Read, Grep y Glob, sin Bash; lista cerrada de bloqueantes tomada de `.claude/rules/*` del repo + genéricas: contrato back/front, transacción multi-tabla, migración sin down, criterio no implementado, string de negocio mágico, secreto en código), `test-writer` (sonnet), `test-runner` (haiku; rojos preexistentes por ruta y nombre desde `tests/known-failures.txt` del repo si existe). El clasificador desaparece: el orquestador decide si hace falta plan.

Cambio de la fase 3 (2026-10-20): `agents/dev.md` (sonnet, effort medium, 72 líneas) lee `CLAUDE.md`, las rules y el manifiesto, y no escribe tests. Corre typecheck una vez y lint de sus archivos al final. Devuelve seis secciones: Contrato resultante, Archivos tocados, Desviaciones, Cobertura con `archivo:línea`, Riesgo y Pendiente para verify. Los cuatro agentes llevan su `model` y su `effort` en el frontmatter.

### 6.5 Mod `arnes-mod` (fase 5, dos piezas, nada más)
1. `prompt.compose`: sección `arnes:protocol` (≤ 25 líneas) en el system prompt, `scope: session`.
2. Al cerrar un turno con diff y sin revisión (`classic.Stop` + ledger): `$.agent.spawn({ subagentType: 'arnes:reviewer' })` y el resultado se adjunta al turno. El modelo no decide si se revisa.

Lo visual no va aquí: vive en `arnes-ui` (§6.5b), que no cambia comportamiento y se puede desactivar sin tocar el flujo.

### 6.5b Mod de interfaz `arnes-ui` (solo muestra, nunca cambia el comportamiento)

Plugin aparte de `arnes-mod`, para que lo visual no comparta destino con lo que gobierna el flujo. Regla única: cada hook observa y devuelve `next(e)` sin tocar nada; si el mod falla, el arnés sigue igual.

Qué muestra:
- **Etapa actual** y su cronología: `Leyendo issue → Planeando → Construyendo (dev api) → Verificando (tsc api, jest 12 specs) → Revisando → Entregando → Guardando memoria`, con duración y costo por etapa (diferencia de `$.session.usage().cost.usd`, §3).
- **Agentes vivos**: nombre, modelo, tiempo transcurrido, última herramienta que usó, botón "ver" que cambia la vista a su transcript (`$.ui.view({ agentId })`, válido porque lo pulsa la persona).
- **Gate por workspace**: rama, árbol sucio/limpio, typecheck ✓/✗/⏳, tests ✓/✗/⏳, review ✓/✗/⏳, bandera vigente o vencida, worktrees abiertos sin integrar.
- **Avisos** como toasts: cambio de etapa, gate en rojo, reviewer terminó con N hallazgos, Stop bloqueado y por qué, zona de riesgo tocada → revisión humana obligatoria.
- **Lo que sigue**: una línea ("falta integrar wt/feature-X/front", "listo para /arnes:ship").

De dónde saca la etapa, sin adivinar por texto:
| Señal | Evento del mod | Etapa |
|---|---|---|
| Una skill anota `start <etapa>` o `end <etapa>` en `timeline.jsonl` | `$.fs` con el reloj, y en el acto tras un Bash que corre `timeline.js` (no `skill.prompt`, §3) | la de la skill; su `end` la cierra |
| Se lanza un subagente `arnes:dev` / `arnes:reviewer` / `arnes:test-writer` | `agent.spawn`, y `turn.complete` con `agentId` cuando termina | Construyendo / Revisando / Escribiendo tests |
| Bash con los scripts del arnés o con el `test` del manifiesto | `tool.call` (inicio y fin; `isError` al cerrar) | Verificando, con el tiempo transcurrido. El workspace sale de la carpeta donde corre el comando (`cd`, `-C`, `--prefix` o el cwd); si esa carpeta no es de un workspace que declare el comando, la etapa va sin workspace y no se marca ningún gate |
| `Edit`/`Write` | `tool.call` | contador de archivos tocados por workspace |
| Request al modelo en vuelo | `turn.step` | "Pensando…" |
| Archivos de estado `.tmp/harness/{plan.md,gate/*.json,worktrees.json}` | `$.fs` leído en cada evento relevante y `$.clock.every(3s)` | tabla del gate y worktrees |
| Compactación | `session.compact` | aviso "contexto compactado" |
| Stop bloqueado | nota `bloqueado` del `stop-gate` en `timeline.jsonl`, leída por el reloj (no `classic.Stop`, §3) | aviso con el motivo |

Superficies: una **banda sobre el prompt** (`ui.render` de `AbovePrompt`), siempre visible a cualquier ancho, una línea: `arnes ▸ Revisando · reviewer opus 00:42 · api ✓tsc ✓tests ⏳review · front ✓tsc ✗tests · 2 wt sin integrar`. Un **panel** (`$.ui.open` + `ui.render` de `Pane`) con la cronología, los agentes y la tabla del gate; en terminal se asienta a partir de 144 columnas si lo abre el mod, o a cualquier ancho si lo abre la persona con `/arnes-panel`. Una **entrada en la status line** (`$.ui.status`) con la etapa. Misma árbol en desktop y VS Code vía `$.ui.resolve(e)`.

Estado: átomos en `$.state` declarados en `types/index.d.ts` (etapa, cronología, agentes, gate por workspace); `$.store` guarda las últimas 20 corridas (issue, duración y costo por etapa, resultado) para un mini historial en el panel.

Motivo declarado por el usuario: ver visualmente en qué etapa se va el tiempo, y hacer la sesión más interactiva. Por eso, al cerrar cada corrida el mod imprime un resumen por etapa (`plan 2m · build 9m · verify 4m · review 6m · ship 1m`) marcando la más lenta y la más cara, y el panel muestra el promedio de las últimas corridas por etapa para distinguir una demora puntual de un cuello de botella estructural (por ejemplo, el reviewer en opus llevándose el 40 % siempre). Esa medición es también la entrada para decidir qué pieza del arnés quitar o abaratar. Comandos: `/arnes-panel` abre o cierra (un comando registrado no lleva prefijo de plugin, §3); `/arnes:timeline` vive en el plugin base y funciona sin el mod. La fuente de verdad de la cronología es `.tmp/harness/timeline.jsonl`, escrita por las skills; el mod la lee y le suma lo que solo él ve (agentes vivos, requests en vuelo, costo por `$.session.usage()` y tokens por agente de `turn.complete.usage`).

Cambio antes del piloto (2026-10-20), por la prueba manual de la fase 3:
- **La etapa de las skills sale de la timeline.** `skill.prompt` no corre (§3), así que el mod deja ese hook y abre la etapa con cada `start` que una skill anota en `timeline.jsonl`, con el workspace del `--ws` como detalle (`Construyendo (api)`). El `end` de esa etapa la cierra, y la status line vuelve a `listo`. La timeline se lee con el reloj de 3 s y, además, en el acto después de un Bash que corre `timeline.js`, para que la etapa de la skill no llegue después que la de la herramienta que sigue. Como el aviso del Stop, la primera lectura solo fija desde dónde: lo viejo no abre etapas.
- **El rojo lo dice el gate.** Un `npx jest` suelto que falla por los rojos conocidos de `tests/known-failures.txt` ya no levanta `gate en rojo` ni marca ✗: un tsc o un test del manifiesto corrido a mano solo marca ✓ si pasa, y si falla la columna queda como estaba. Las columnas tsc y tests las marca `ci-gate`, leyendo de su salida la línea `typecheck` y la línea `tests` de cada `== <ws>`, y el aviso sale solo cuando ci-gate termina en rojo, con los pasos en `FALLA` (`gate en rojo: ✗ ci-gate api (tests)`). Se eligió guiarse por el gate y no leer `known-failures.txt` desde el mod, porque eso obligaba a repetir en el mod el parser de la salida de jest que ya tiene `test-baseline.js`. Lo mismo vale para tsc: un repo con diagnósticos previos también sale de tsc con error.
- **La línea `Plan:` del panel.** La skill escribe `# Plan: <título>` y el panel ya antepone `Plan:`, así que la línea salía `Plan: Plan: …`. Ahora el título se limpia en `lib.planTitle`: sin BOM, sin las marcas de título ni el `Plan:` de la skill, sin `*` ni backticks, sin caracteres de control, de ancho cero ni selectores de variante, en NFC y cortado a 60 puntos de código con `…`, nunca a mitad de un carácter. El texto corrupto de la prueba (`Plnd CRUD dw talleres`) no se pudo reproducir: `claude plugin test` da el árbol de componentes, no el cuadro de la terminal. Lo que se quitó son las fuentes conocidas de desfase entre el ancho que calcula el motor y el que dibuja la terminal. Se confirma en la próxima prueba manual.
- **Costo por agente.** Cada agente muestra en el panel su costo en dólares junto a los tokens, con la fórmula de las etapas: la diferencia de `$.session.usage().cost.usd` entre su `agent.spawn` y su `turn.complete`. Es exacto para un agente que corre solo mientras el hilo principal lo espera, que es como lanzan sus agentes build, verify y review. Con agentes en paralelo, cada uno incluye lo que gastaron los demás en ese lapso.

Cambio de la fase 3 (2026-10-20): `arnes-ui` lee `.tmp/harness/worktrees.json` en cada refresco. La banda suma `N wt sin integrar`, el panel lista cada worktree abierto con su rama y su destino, y "Lo que sigue" pide `/arnes:worktree integrate` antes que verificar. Abierto es sin integrar, como en `worktree-ledger.js pending`; el mod no cuenta commits.

Tamaño objetivo: un `register.tsx` de 200–300 líneas más el contrato de tipos. Se construye justo después de la fase 2, antes que `arnes-mod`, porque es la mejor herramienta para depurar las fases 3 y 4: ver las etapas hace visible lo que el arnés está haciendo.

### 6.6 Memoria
- Mapa del código: graphify por repo (`graphify claude install --project`, `graphify hook install` para rebuild en commit/checkout; `.graphifyignore`; `GRAPHIFY_BACKEND=none` al inicio, solo código). `graphify-out/GRAPH_REPORT.md` se versiona; `graph.json` según tamaño.
- Memoria episódica: markdown versionado en el repo (`docs/decisions/`, `docs/gotchas.md`), escrito por la skill `memory`, leído por `SessionStart` e indexado por graphify. Visible para todo el equipo y para los MR.
- Engram: opcional y personal; el arnés no depende de él.

### 6.7 Reglas mecánicas por repo (la palanca más grande)
Al adoptar un repo se mueven a herramientas las reglas que hoy son prosa: ESLint `no-restricted-imports` (decoradores HTTP propios, nada de Zod donde no aplica), regla de cero comentarios, `no-restricted-syntax` para `new` fuera de factories, `dependency-cruiser` para capas y aislamiento entre contextos. Lo que no es lintable va a `.claude/rules/*.md` con `paths:` y a la lista cerrada del reviewer.

## 7. Worktrees e integración: que nada se quede sin mergear

Problema observado: con varios agentes en paralelo, cada uno en su worktree y su rama, la integración depende de que alguien se acuerde. Hoy renova365 tiene 12 worktrees huérfanos en `api/`.

Diseño:
1. **Un solo destino: la rama del issue.** Nunca ramas personales de integración de larga vida (derivan en una segunda `main` y en MR gigantes). `main` solo recibe MR. La rama "genérica" que buscas ya existe y se llama rama del issue.
2. **Ramas de agente efímeras y nombradas por su destino**: `wt/<rama-issue>/<slug>`, creadas desde la rama del issue (equivalente a `baseRef: head`), nunca desde `main`. Con ese nombre, `git branch --list 'wt/feature/X/*'` y `git branch --no-merged feature/X` dicen mecánicamente qué falta integrar.
3. **Ledger**: `.tmp/harness/worktrees.json` con `{ ws, path, branch, target, issue, openedAt, status }`. Solo la skill `worktree` abre y cierra; en carpetas multi-repo abre un *set* (uno por workspace, mismo nombre).
4. **Fan-in determinista**: el agente no pushea ni mergea. Cuando termina, el orquestador integra en la misma respuesta: `git merge --no-ff wt/...` en la rama del issue (decisión tomada: nunca squash en este nivel; el squash lo hace el host git al mergear el MR a `main`), resuelve conflictos, corre `verify`, borra worktree y rama, cierra el ledger. Un agente "terminó" solo cuando su rama ya no existe.
5. **Cuatro cercos** para cuando algo se salta el paso 4: `Stop` bloquea terminar el turno con worktrees sin integrar; `SessionStart` lista los pendientes al abrir ("tienes 3 ramas de agente sin integrar en api"); `ship` se niega a abrir MR con pendientes; `WorktreeRemove` se niega a borrar con commits sin integrar.
   Antes del primer cerco está el aviso de sesión concurrente (mejora 3, fase 3): si `SessionStart` ve otra sesión activa en la misma carpeta o en el mismo repo, avisa que esta debe abrir su propio worktree en vez de compartir el árbol.
6. **Cuándo no usar worktrees**: si los agentes tocan archivos disjuntos, corren en el mismo árbol, secuenciales o en paralelo, sin ramas: cero integración. Worktrees solo cuando habría conflicto real.
7. **Limpieza**: `worktree prune` + barrido en `SessionStart` de worktrees con más de 7 días sin commits nuevos → aviso, nunca borrado silencioso.
8. `.worktreeinclude` con `.env` en cada repo para que los worktrees arranquen con entorno.

Cambio de la fase 3 (2026-10-19 y 20):
- Punto 3: el registro quedó como en §6.1, con los worktrees bajo `.tmp/harness/worktrees/<ws>/<slug>`.
- Punto 4: `integrate` hace merge, borrado y cierre en un paso, y verify corre después sobre la rama del issue. Borrar antes de verificar no pierde nada, porque los commits ya están en la rama del issue.
- Punto 5, los cuatro cercos, hechos:
  - Stop (b);
  - SessionStart;
  - ship, con `worktree-ledger.js pending --target <rama>`, que sale con 1 si hay abiertos;
  - borrar un worktree, por el ledger en `ExitWorktree` y en el guard.
- Punto 7: `SessionStart` solo avisa y nunca corre `git worktree prune`, porque un hook no escribe en git. `integrate` y `close` hacen `prune` cuando la carpeta del worktree ya no existe.
- Punto 8: no se hizo. Los worktrees que abre el ledger no copian `.env` ni enlazan `node_modules`: para verificar dentro de uno hay que instalar dependencias. Va con los templates de la fase 6.

Nota: Claude Code trae `/batch`, donde cada subagente trabaja en su worktree y abre su propio PR. Sirve cuando las tareas son issues independientes; no para partes de un mismo issue, que es el caso de este diseño.

## 8. Mínimo de adopción (lo comprueba `arnes:init --check`)

Adoptar un repo empieza por quitar los hooks del arnés anterior de su `.claude/settings.json`, y del de la carpeta si lo tiene. Esos hooks corren además de los del plugin, y un guard viejo niega lo que el arnés deja pasar (§3). Hoy están en ese caso `api-academico` y renova365.

1. `.claude/harness.json` válido contra el schema.
2. `CLAUDE.md` con reglas duras del stack (≤ 200 líneas) y `.claude/rules/` con `paths:`.
3. Typecheck y lint ejecutables sin `--fix`.
4. Job de CI que corre `ci-gate.js` (los mismos scripts) y bloquea el MR si falla; el host git configurado con "merge solo si el pipeline pasa", squash al mergear a `main`, y detección de secretos activada (GitLab Secret Detection o equivalente en Bitbucket).
5. `riskPaths` declaradas y regla de aprobación en el host git: GitLab, approval rules por patrón de archivo o `CODEOWNERS` (según plan; en Free: rama protegida + pipeline obligatorio + plantilla de MR con el revisor); Bitbucket, default reviewers + restricciones de rama.
6. Plugin fijado a un tag en `~/.claude/settings.json` o en `.claude/settings.json` del repo.
7. Ningún hook del `.claude/settings.json` del repo o de la carpeta corre scripts propios de `.claude/hooks/`.
8. Línea base de tests commiteada (`tests/baseline.json` o la ruta del schema), con los saltos declarados por nombre; un commit que la cambia lleva el prefijo `gates:` (§6.1). Desde la fase 3.

Hallazgos de las pruebas de la fase 3 sobre clones de api-academico, para cuando se adopte (fase 6). No son del arnés:
- `main` no tiene `CLAUDE.md` ni `.claude/rules` en la raíz: viven en las ramas de trabajo, así que un issue que nace de `main` no ve las convenciones.
- El `.gitignore` de las ramas de trabajo ignora `docs`. Las decisiones que escribe memory no se versionan sin `git add -f`, aunque `docs/decisions/0001-…` sí está trackeado de antes; memory lo avisa. Adoptar el repo es quitar `docs` del `.gitignore`.
- El eslint no cubre `scripts/*.js`: todo archivo ahí falla con `was not found by the project service`, y en verify y en sync aparece como lint rojo de un archivo tocado o que entró.
- `main` trae specs con líneas que el propio Prettier del repo rechaza (fase 3a), así que tocar uno de esos specs pone rojo el lint hasta formatearlo.
- El issue de talleres pedía "solo ADMIN y COORDINADOR". El plan lo tradujo a permisos `taller.*` más los otorgamientos en el mantenedor de roles, porque las rules del repo prohíben comparar nombres de rol (pregunta cerrada P3). `coordinador` existe como rol de datos (`acl_rol`), no como constante `ACL_ROL_*`.
- Un cambio de inyección de dependencias, como mover `TallerRepository` a `PersistenciaModule` (regla §7 del repo), no lo detectan ni tsc ni jest: hace falta arrancar la app con base de datos. Para el arnés es la decisión abierta 9 de §12.

El README del arnés trae además la lista de permisos recomendada para `~/.claude/settings.json` (los `node` de los scripts del plugin, `git` de lectura, los comandos de test del manifiesto), para que el flujo no se detenga en diálogos de permiso; sin ella el arnés funciona, pero pregunta.

## 9. Versionado y compatibilidad

- Tags semver en `agentic-harness`; un tag cubre los tres plugins (`arnes`, `arnes-ui`, `arnes-mod`). `CHANGELOG.md`.
- Instalación: `claude plugin install arnes --marketplace <fuente>#vX.Y.Z` (user scope), donde `<fuente>` depende del host: la forma corta `owner/repo` es solo para GitHub; en GitLab u otro host va la URL completa de clonado, `https://gitlab.com/preupdv/apps/agentic-harness.git#vX.Y.Z` (o `git@gitlab.com:preupdv/apps/agentic-harness.git`). `arnes-ui` y `arnes-mod` se instalan aparte, por nombre, desde el mismo marketplace. El host se elige donde el equipo que lo va a instalar ya tiene credenciales: para academico, GitLab (`preupdv`), y el CI es `.gitlab-ci.yml`. Auto-update apagado. Rollback = re-añadir el marketplace en el tag anterior. Desinstalar: `claude plugin uninstall <nombre>@agentic-harness`.
- README con matriz tag ↔ versiones de Claude Code probadas. CI del arnés: `claude plugin validate` sobre los tres, tests de scripts con repos de juguete (`node --test`), `claude plugin test` para los mods, y más adelante `claude plugin eval`.
- El equipo sube CLI y arnés juntos, nunca uno solo.

## 10. Fases y criterio de salida

| Fase | Entregable | Sale cuando |
|---|---|---|
| 0 | Repo con marketplace + tres plugins vacíos, README con principios, permisos y matriz, `docs/PLAN.md`, CI con `validate` | `claude plugin validate` pasa en los tres y `claude --plugin-dir ./plugins/arnes` carga y muestra `/arnes:init` |
| 1 | Schema + manifiesto + `init` + `touched-files`, `typecheck-baseline`, `test-select`, `gate-flag`, `adoption-check`, `ci-gate`, `lib/timeline` con tests de juguete | Los scripts pasan en academico (3 ws) y en renova365 (2 ws); `ci-gate` corre en un pipeline real |
| 2 | Hooks clásicos: `guard` → `after-edit` → `session-start` → `stop-gate` → `worktree-remove` | Una sesión normal en api-academico lintea sola tras editar y no deja commitear sin bandera; el `Stop` bloquea una vez y suelta con `stop_hook_active` |
| 2b | `arnes-ui`: banda, panel, status, toasts, `/arnes-panel`; `/arnes:timeline` en el plugin base | Muestra etapa, agentes y gate en una sesión real; desactivado, nada cambia y la timeline sigue existiendo |
| 3 | Skills `plan/build/verify/review/ship/memory/sync` + 4 agentes + `worktree` con ledger; línea base de tests en `ci-gate` y `verify` (§6.1) y aviso de sesión concurrente en `session-start` (§6.2) | Un issue real de api-academico de punta a punta, sin invocar comandos |
| 4 | Piloto: un issue de back de patrón conocido hecho por un dev de front con el arnés | Cuatro números anotados: hallazgos del reviewer, hallazgos del humano en el plan, defectos que llegaron a QA, minutos por etapa según la timeline |
| 5 | `arnes-mod` (protocolo en system prompt, reviewer determinista) | Funciona y, desactivado, el plugin sigue completo |
| 6 | graphify por repo, memoria en markdown, script de setup por carpeta, migración de renova365 y api-academico (borrar sus `.claude/` viejos, limpiar worktrees huérfanos, quitar permisos de push, sacar la contraseña de `settings.local.json`) | Las tres carpetas corren el mismo tag |
| 7 | Publicación: licencia MIT; README en español e inglés (qué problema resuelve, qué no hace, instalación, el manifiesto con un ejemplo de repo y uno de carpeta, y una comparación honesta con gentle-ai, coding-agent-harness, harness-template y Superpowers); limpieza de todo lo personal en docs y tests (rutas con nombre de usuario, nombres de repos privados y de personas, reemplazados por ejemplos genéricos; los manifiestos reales de academico y renova365 fuera del repo, con fixtures anónimos en su lugar); `CONTRIBUTING` y `SECURITY` cortos; CI público con validate, tests y `plugin test`; espejo en GitHub con el marketplace apuntando a él, porque el atajo `owner/repo` de instalación y la mayoría de los usuarios de plugins están ahí | El CI público está en verde, el espejo instala con `owner/repo` y no queda nada personal en el repo. El tag 1.0.0 sale solo cuando el piloto de la fase 4 haya pasado y las tres carpetas corran el mismo tag |

Cambio de la fase 3 (2026-10-19 y 20): se construyó en dos mitades, en paralelo y desde `feature/fase-2b-ui`. La 3a hizo verify, review, ship, los agentes reviewer, test-writer y test-runner, la línea base de tests y el punto 8 de `adoption-check`. La 3b hizo plan, build, worktree, memory, sync, el agente dev, los cercos de §7 y el aviso de sesión concurrente. Las dos se integraron en `feature/fase-3` con `merge --no-ff`, y el cierre cableó lo que cruzaba de una a otra: ship con el ledger, `arnes-ui` con los worktrees, los textos de los hooks con las skills y la foto de typecheck reutilizada. Salió con la versión 0.5.0 (tag `v0.5.0`) el 2026-10-20, cuando la persona confirmó la prueba de `docs/PRUEBA-FASE-3.md` en una sesión interactiva.

## 11. Lo que NO se hace (lista anti-sobreingeniería)

- Sin clasificador formal de 8 reglas: el orquestador decide si hay plan.
- Sin marcador de gate con huella SHA-256 del árbol: bandera simple + CI como garantía real.
- Sin protocolo de handoff con `CONTEXT_ID`: `.tmp/harness/plan.md` y punto.
- Sin validación mecánica de citas `archivo:línea` contra el diff: el reviewer comprueba cumplimiento.
- Sin comandos de 300 líneas ni el "por qué" de cada regla en el prompt: el porqué va al README y al changelog.
- Sin ramas personales de integración.
- Sin regex sobre texto libre en el guard: parseo por segmentos y solo ejecutables.
- Sin dependencia de Engram ni de ningún MCP para que el flujo funcione.
- Sin lista de rojos conocidos como institución: si una suite está rota, el issue es arreglarla; la lista es temporal y con fecha.

## 12. Decisiones tomadas y abiertas

Tomadas (2026-10-19):
1. Nombre del plugin: `arnes` (prefijo `/arnes:plan`, `/arnes:ship`, …; el mod es `arnes-mod`). Sin tilde, corto, literal para el equipo.
2. Integración en dos niveles: rama de agente → rama del issue con `git merge --no-ff` (git registra la integración, `branch --no-merged` sigue siendo la comprobación mecánica, revertir una tarea es revertir un commit de merge); rama del issue → `main` con squash, configurado en GitLab/Bitbucket al mergear el MR, para que `main` reciba un commit limpio por issue. El arnés nunca hace squash por su cuenta.

Tomadas en la fase 3 (2026-10-19 y 20):
- verify corre el mismo motor que el CI (`ci-gate.js --base HEAD`).
- Una falla que coincide exacto con una línea fechada de `tests/known-failures.txt` no pone el gate en rojo.
- ship se niega si la revisión tiene bloqueantes.
- Los worktrees del ledger viven bajo `.tmp/harness/worktrees/`.
- El Stop (b) solo bloquea un turno que sumó commits, como (a).
- Integrar borra el worktree antes de verify.

Abiertas:
3. Plan de GitLab del equipo (define si hay approval rules por patrón o se usa la vía Free).
4. Graphify: solo código al principio; cuándo activar la pasada semántica de docs.
5. Qué issue y qué persona para el piloto de la fase 4.
6. Si `academicoBitbuckett` (PHP) entra en la fase 1 o se deja como workspace "solo lectura" hasta tener lint y tests.
7. El `CLAUDE.md` global del usuario exige Engram en toda sesión; cuando la memoria pase a markdown (fase 6) hay que reescribir ese archivo, o Engram seguirá siendo obligatorio por instrucción aunque el arnés no lo use.
8. Si el arnés se envía a la comunidad de plugins de Anthropic una vez publicado (fase 7).
9. Un comando de arranque opcional en el manifiesto (por ejemplo `commands.boot`) que verify corra si existe, para los errores que ni tsc ni jest ven, como un cambio de inyección de dependencias. Tiene que terminar solo, levantando la app y cerrándola, porque el arnés no mata procesos, y en api-academico necesita base de datos.

## 13. Fuentes consultadas

- https://code.claude.com/docs/en/large-codebases
- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/worktrees
- https://code.claude.com/docs/en/plugins/install
- https://code.claude.com/docs/en/plugins/create
- https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more
- https://www.anthropic.com/engineering/harness-design-long-running-apps
- https://github.com/obra/superpowers
- https://github.com/Graphify-Labs/graphify
- API de mods: `plugin-authoring/types/claude-code.d.ts` (build 2.1.303)
