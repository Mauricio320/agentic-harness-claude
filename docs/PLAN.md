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
- Verificado en la primera corrida real (2026-10-20, Claude Code 2.1.304), en su transcript:
  - Los subagentes que lanza la herramienta Agent corren en segundo plano, aunque no se pida `run_in_background`. El turno del hilo principal cierra segundos después de lanzarlos, `turn.complete` sin `agentId` llega en ese momento, y el hilo principal se reabre solo cuando el agente termina, sin `UserPromptSubmit`. Una medición que se corte por turno del hilo principal queda partida en pedazos. En la corrida salieron once resúmenes de "corrida", uno por turno, y la cronología del panel decía "sin etapas en esta corrida" mientras el dev trabajaba.
  - Cuando un agente en segundo plano termina, el aviso que reabre el turno del hilo principal (`<task-notification>`, que el transcript muestra como "Another Claude session sent a message: <agent-message …> [Subagent hand-back]") dispara UserPromptSubmit, como un mensaje de la persona. Los hooks que cuentan turnos o respuestas tienen que distinguirlo (§6.2, tercera ronda).
  - Las herramientas de un subagente pasan por el `tool.call` del mod con su `agentId`. Los `tsc` que corre el dev abrían la etapa Verificando en pleno build, y por eso todos los resúmenes de esa corrida decían Verificando.

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
        lib/branches.js                  # commits de una rama fuera de la rama por defecto (branch -D, worktrees); dónde está el manifiesto que un repo no tiene
        lib/database.js                  # los comandos que tocan una base: los propone init-draft, los niega el guard
        init-draft.js                    # detección determinista de arnes:init: repos, stack, comandos, specPattern; escribe los dos niveles de §5
        touched-files.js                 # modificados + untracked por workspace
        typecheck-baseline.js            # foto y diff por diagnóstico (parser tsc; interfaz para otros)
        test-select.js                   # deriva specs de archivos tocados según specPattern
        merged-files.js                  # intersección real tras un merge
        worktree-ledger.js               # registro de worktrees por issue; pendientes de integrar
        gate-flag.js                     # escribe/valida la bandera de verificación
        test-baseline.js                 # línea base de tests commiteada: capture y check (§6.1)
        review.js                        # entrada del reviewer sin Bash, rondas de corrección y marca de revisión hecha
        ship.js                          # check, rama y stage de ship
        adoption-check.js                # las 8 comprobaciones del mínimo
        adopt.js                         # lo determinista de init: tests legibles, línea base, hooks viejos, permisos, CLAUDE.md de carpeta
        ci-gate.js                       # lo que corre el CI: touched-files + typecheck + convenciones + lint + test-select sobre el MR
        conventions.js                   # las convenciones mecánicas del manifiesto sobre lo que cambió, con archivo y línea
        plan-state.js                    # el plan de la corrida: estado, aprobación de la persona y plan trivial
        hooks/{session-start,prompt-context,after-edit,guard,plan-guard,read-guard,stop-gate,worktree-remove}.js   # session-start atiende también SessionEnd
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

Desde la tercera ronda antes del piloto, el workspace admite `conventions`: las convenciones mecánicas que `conventions.js` comprueba en el gate (§6.1).

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

Cambio de la segunda ronda antes del piloto (2026-10-20), por la primera corrida real, desde la raíz de academico con api-academico y academico-front:
- **Diagnósticos en archivos ignorados por git.** El typecheck del front contó como nuevo un error en `.next/dev/types/validator.ts`, que genera `next dev` y git ignora. La foto del base sale de `git archive` y no lo tiene, y el árbol actual sí. Ahora `typecheck-baseline` y `ci-gate` descartan de los dos lados todo diagnóstico de un archivo ignorado (`git check-ignore --stdin`, desde la carpeta del workspace) y lo dicen en una línea: `descartados los diagnósticos de N archivo(s) ignorado(s) por git: …`. Si una corrida es válida se juzga antes de descartar, para que un typecheck que solo falla en archivos ignorados no pase por una corrida que no llegó a correr.
- **El commit contra la bandera.** El hook pre-commit del front corre `eslint --fix` sobre lo que está en stage. Esa vez no cambió nada, pero si cambia, el commit lleva un contenido distinto del que verificó la bandera, y el arnés no se entera. Ahora la bandera guarda también `blobs`: el blob que git guardaría de cada tocado (`git hash-object --stdin-paths` desde la raíz del repo, que normaliza los finales de línea como el commit). `ship.js committed <ws>`, que ship corre después de cada commit, compara el blob de HEAD de cada archivo con el de la bandera, y si alguno difiere sale con 1, `FALLA` y los archivos. Una bandera escrita antes, sin `blobs`, no se puede comparar y lo dice.
- Cambio de la tercera ronda antes del piloto (2026-10-20). **Convenciones baratas antes del revisor caro.** La ronda 1 de review de la corrida del compañero encontró diez bloqueantes, y nueve eran mecánicos: comentarios, un banner, `as unknown as` y datos de prueba a mano. Cada uno costó un dev, un test-writer, un verify y una ronda de review. Ahora el gate tiene un chequeo determinista, `conventions.js`:
  - corre la lista `conventions` del workspace, con `{ id, pattern, message, exclude?, unless? }` (`$defs.convention` del schema), sobre lo que cambió en los tocados de código: un archivo nuevo entero, y uno modificado solo en sus líneas agregadas o cambiadas, para que una violación que ya estaba no ponga rojo;
  - pone el gate en rojo con `archivo:línea · id · mensaje`;
  - corre en `ci-gate`, y con él en verify y en el CI, como paso `convenciones` antes del lint;
  - el dev lo corre sobre sus archivos antes de entregar, porque build le pasa el comando, y corrige él mismo;
  - `init-draft` propone cuatro reglas a un repo JS o TS: comentarios de línea y de bloque, salvo `eslint-disable` o la justificación de `any`; `as unknown as` y `: any`; `console.` fuera de los tests; y `TODO`. Los datos de prueba escritos a mano no se pueden comprobar sin criterio y siguen en el reviewer;
  - el reviewer ya no reporta lo que cubren las convenciones: se queda con lo que exige criterio (§6.4).
- **Sin contract no hay orden.** El chequeo de ship imprimió el orden front → back porque ningún manifiesto declaraba `contract`, y la skill tuvo que corregirlo a mano. Con dos o más workspaces y ningún `provides` ni `consumes`, `ship.js check` avisa en una línea que el orden es el del manifiesto, y `adoption-check` lo marca como FALTA en la comprobación 1.

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
| `PreToolUse` (`Edit\|Write`) | `plan-guard.js` | Deniega escribir código de un workspace sin plan aprobado en la corrida. Desde la tercera ronda antes del piloto (abajo) |
| `PreToolUse` (`Read\|Glob\|Grep`) | `read-guard.js` | Deniega abrir o buscar en archivos de secretos, para que nunca entren al transcript. La lista fija cubre `.env` y variantes (salvo `.env.example`), lo que esté dentro de `~/.ssh` y `~/.aws`, credenciales, tokens y llaves privadas; `secretPaths` del manifiesto la amplía por workspace. Aplica siempre, haya o no manifiesto, como las reglas destructivas de git. Read se juzga por `file_path`, Glob por `path` y `pattern`, y Grep por `path` y `glob`. Un Grep sobre una carpeta entera no se deniega (ripgrep salta lo ignorado), y un `cat .env` por Bash lo juzga el guard. Mejora 2, construida con las correcciones de la fase 2b |

Cambio de la fase 2 (2026-10-19): `WorktreeRemove` no sirve para este rechazo. Según la documentación de 2.1.303, ese evento solo se dispara para worktrees creados por un hook `WorktreeCreate` propio, y un hook que sale con 0 cuenta como si hubiera borrado el directorio. Los worktrees de git, que son los del §7, los borra Claude Code sin pasar por él. Los dos caminos reales para que un agente borre un worktree son la herramienta `ExitWorktree` (exige `discard_changes: true` con commits sin mergear, pero el modelo puede pasarlo) y `git worktree remove` por shell, y los dos pasan por `PreToolUse`.

Cambio de la segunda ronda antes del piloto (2026-10-20), por la primera corrida real:
- **La espera de la persona, en cualquier etapa.** La espera solo se contaba en plan, con su nota `esperando`. En la corrida hubo otras dos, de once y doce minutos, cuando verify y review cerraron el turno con una pregunta, y la timeline no las cargó a nada. Ahora es genérica y determinista. El `Stop`, cuando el turno cierra de verdad (no cuando lo bloquea), anota `{ stage: "turno", result: "cerrado" }`. `UserPromptSubmit` anota `{ stage: "turno", result: "respuesta" }`. El hueco entre el último cierre y la respuesta es espera de la persona, de toda la corrida y aparte de las etapas. Un turno que se reabre solo, por ejemplo cuando termina un agente en segundo plano, no trae respuesta, así que cuenta el último cierre antes de que la persona escriba. plan ya no escribe `esperando`: sigue cerrando su etapa al escribir el plan, y anota `aprobado` o `cancelado`.
- **"verificado, falta review".** Cuando el turno cierra con bandera vigente y sin una revisión de ese contenido (`review.js check`: sin revisión, o de otro árbol), el `Stop` avisa en una línea con `systemMessage`, sin bloquear. Una revisión con bloqueantes no avisa, porque ya se sabe que falta corregir.

Cambio de la tercera ronda antes del piloto (2026-10-20), por la corrida de un front en su Mac con la 0.5.2:
- **El plan es obligatorio.** En su sesión el pedido no cargó `arnes:plan`: Claude hizo tres preguntas con su herramienta nativa, dijo "elegiste" y se puso a leer módulos para escribir código, con el panel en "sin etapas". Verificar lo exige el Stop, y revisar lo exige ship, pero planificar dependía de que el modelo decidiera cargar la skill. Ahora hay tres capas deterministas:
  - **`plan-guard.js`, un `PreToolUse` sobre `Edit|Write`.** Niega escribir un archivo de código de un workspace adoptable (sus `codeGlobs`) cuando la corrida no tiene plan aprobado. Plan aprobado es un `start plan` sin un `end ship` ok después y con su nota `aprobado` (`lib/timeline.js` `planState`). El motivo dice `no hay plan aprobado: carga /arnes:plan, o /arnes:plan --trivial si el cambio es mínimo`. Corre también en las llamadas de los agentes, porque los hooks del plugin corren en ellas. No juzga lo que no es código, nada bajo `.claude/` o `.tmp/` del workspace, ni un archivo fuera de todo workspace, ni una sesión sin manifiesto. Un archivo de un worktree del ledger usa el plan del checkout principal.
  - **UserPromptSubmit.** Sin plan en curso y sin código tocado, agrega una sola línea: `si este mensaje pide cambiar código, la primera acción es cargar arnes:plan`. El protocolo de SessionStart suma la misma regla.
  - **El escape `/arnes:plan --trivial`.** `plan-state.js trivial` escribe un `plan.md` de una pantalla, con el pedido y un criterio, y lo deja aprobado sin preguntar. Lo invoca solo la persona: UserPromptSubmit marca con `trivial` la nota de respuesta cuando el mensaje es `/arnes:plan --trivial`, escrito o expandido por el CLI, y el script se niega sin esa marca. La skill plan sigue siendo invocable por el modelo para el plan completo.
  - **La aprobación la anota `plan-state.js approve`, no el modelo.** El script exige el plan escrito (`end plan`) y, después, una respuesta de la persona. Sin eso, el guard sería fácil de rodear: el modelo podía anotar su propia aprobación en el mismo turno. `timeline.js` se niega a escribir la nota `aprobado`. La skill termina el turno con el plan, sin la herramienta de preguntas, porque una respuesta por esa herramienta no pasa por UserPromptSubmit.
- **El Stop dejaba pasar código que escribieron los devs en segundo plano.** El turno de build terminó con "Construido, sin verificar. Sigue verify.", y el Stop dijo "este turno no los tocó". En la transcripción de la primera corrida está la causa: el aviso con que un agente en segundo plano reabre el turno (`<task-notification>`) también dispara UserPromptSubmit. `prompt-context` reescribía la foto del turno en ese momento, cuando el dev ya había escrito, y el Stop comparaba contra esa foto. La foto ya era del árbol (`stateOf`, la huella de los tocados de cada workspace); el problema era cuándo se tomaba. Ahora solo un mensaje de la persona abre turno: deja la foto y la nota `respuesta`. El aviso de un agente no deja ninguna de las dos, aunque UserPromptSubmit siga agregando la línea de estado. Así, cuando el Stop compara, cuenta todo lo que cambió el árbol desde el mensaje de la persona, lo haya escrito quien sea. Arregla también la medición: en la 0.5.2, cada aviso de un agente contaba como una respuesta de la persona y cerraba una espera.
- **build encadena a verify.** Cuando el último dev entrega, la skill carga verify en el mismo turno, en vez de cerrar con "sigue verify".

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
  - Rondas de corrección. En la corrida automática, review fue la etapa más cara: tres rondas, cada una con verify y review completos. Ahora:
    - verify se repite entero en cada ronda, porque la bandera exige el contenido actual de cada tocado.
    - La ronda 1 de review es completa. La 2 y la 3 son acotadas: el reviewer recibe el reporte de la ronda anterior y solo el diff de la corrección, y juzga si cada bloqueante anterior quedó resuelto y si la corrección trae uno nuevo de la lista cerrada. Una ronda vuelve a ser completa si la corrección tocó archivos fuera de los tocados de la ronda anterior.
    - Tope de dos rondas de corrección. Si la ronda 3 termina con bloqueantes, `mark` lo dice, la skill no corrige más y se lo reporta a la persona, y `review.js input` se niega a una cuarta. `review.js input --completa` vuelve a la ronda 1, solo si la persona lo pide.
    - La cuenta la lleva `review.js`, no la prosa. `input` guarda en `input.json` el árbol revisado de cada workspace: un árbol de git escrito con un índice temporal, que es una copia del real más los tocados y los borrados. No toca el índice, las ramas ni el disco, y solo deja objetos sueltos que git recoge solo con el tiempo. La ronda siguiente saca de ahí el diff de la corrección (`git diff <árbol revisado> <árbol actual>`). Una ronda es de corrección si la anterior tuvo bloqueantes y el HEAD no cambió. Con otro HEAD, por ejemplo después de un commit, se empieza en la ronda 1. Si no cambió nada desde la ronda con bloqueantes, `input` se niega.
    - `mark` exige el reporte del reviewer tal cual en `.tmp/harness/review/report.md`, que la skill guarda con Write, y se niega si su línea `BLOQUEANTES` no coincide con `--blockers`. Lo guarda como `review/ronda-<n>.md` para la ronda siguiente, y `review.json` anota la ronda y el modo. La timeline anota la ronda en el detalle del fin de review.
    - Las rondas acotadas van en sonnet (§6.4).
- Cambio de la segunda ronda antes del piloto (2026-10-20), por la primera corrida real:
  - **Acotar también después de una revisión limpia.** La segunda revisión de la corrida fue completa y en opus, aunque solo se habían aplicado las cuatro sugerencias de la primera, porque `review.js` solo acotaba tras bloqueantes. Ahora, si la revisión anterior no tuvo bloqueantes, el HEAD no cambió y el cambio no sale de los archivos ya revisados, la ronda siguiente es acotada: el diff desde lo revisado y el reporte anterior, en sonnet. Si sale de lo revisado, es trabajo nuevo y vuelve a la ronda 1 completa. Sin cambios desde una revisión limpia, `input` se niega, porque esa revisión sigue valiendo, y `--completa` revisa de nuevo. El tope sigue contando solo rondas con bloqueantes.
  - **El inicio de review se anota después de decidir.** La skill escribía `start review --detail "ronda acotada"` antes de correr `review.js input`, y la ronda salió completa. Ahora corre primero `input` y anota `start review --detail "ronda <n> <modo>"` con lo que el script decidió. Si no hay nada que revisar o el script se niega, deja una nota (`note review`) en vez de abrir la etapa.
  - **Citas con líneas reales.** El reviewer citó las líneas 407 y 447 de un archivo más corto, porque numeraba sobre el diff que recibe. Ahora `review.js` numera el diff con la línea de cada renglón en el árbol final, y las borradas van sin número. Cuesta seis caracteres por renglón, menos que pedirle leer cada archivo entero. Un test comprueba que cada número citado cae dentro del archivo y es la línea que dice.
  - **La timeline con espera y costo.** `timeline.js print` ya no imprime las notas del turno: la respuesta que cierra una espera sale con su duración, y al final va `espera de la persona: <total> en <n> respuesta(s), aparte de las etapas`, o `esperando a la persona desde …` si el último turno sigue sin respuesta. arnes-ui anota al cerrar cada etapa una nota `costo` con `usd`, la diferencia del costo de la sesión desde su inicio (§6.5b). print la pega al fin de la etapa y la suma por etapa: `por etapa: plan 3m27s $0.77 · …`. Sin el mod no hay costo, y print muestra solo tiempos.
  - **verify y review no se detienen entre etapas.** Cuando verify quedó en rojo por la caché de Next y preguntó si borraba la carpeta, la persona dijo que sí. verify borró, verificó en verde y cerró el turno con "falta revisar". Ahora, dentro de un issue en curso (`plan.md` con `Aprobado:`), verify en verde sigue con review aunque el turno haya empezado con una respuesta de la persona. review sin bloqueantes cierra con `Listo para /arnes:ship`, y con bloqueantes sigue con la corrección hasta el tope. El Stop agrega un aviso de una línea cuando hay bandera vigente sin revisión (§6.2).

### 6.4 Agentes
`dev` (sonnet, Read/Write/Edit/Bash/Glob/Grep; lee `CLAUDE.md` y rules del workspace; no escribe tests; devuelve contrato resultante y criterios cubiertos con `archivo:línea`), `reviewer` (opus, solo lectura con Read, Grep y Glob, sin Bash; lista cerrada de bloqueantes tomada de `.claude/rules/*` del repo + genéricas: contrato back/front, transacción multi-tabla, migración sin down, criterio no implementado, string de negocio mágico, secreto en código), `test-writer` (sonnet), `test-runner` (haiku; rojos preexistentes por ruta y nombre desde `tests/known-failures.txt` del repo si existe). El clasificador desaparece: el orquestador decide si hace falta plan.

Cambio de la fase 3 (2026-10-20): `agents/dev.md` (sonnet, effort medium, 72 líneas) lee `CLAUDE.md`, las rules y el manifiesto, y no escribe tests. Corre typecheck una vez y lint de sus archivos al final. Devuelve seis secciones: Contrato resultante, Archivos tocados, Desviaciones, Cobertura con `archivo:línea`, Riesgo y Pendiente para verify. Los cuatro agentes llevan su `model` y su `effort` en el frontmatter.

Cambio antes del piloto (2026-10-20): las rondas acotadas de review (§6.3) van en sonnet, y la completa sigue en opus.
- **Por qué sonnet:** una ronda acotada es una comprobación contra una lista corta y explícita: cada bloqueante anterior con su línea y su regla, sobre un diff chico, con la lista cerrada para los nuevos. El juicio sobre el árbol entero y los criterios del plan, que es lo que justifica opus, queda en la ronda completa.
- **Riesgo aceptado:** que sonnet deje pasar un bloqueante nuevo en la corrección. Lo acotan tres cosas: la corrección es chica, una corrección que sale del diff anterior vuelve a una ronda completa en opus, y las riskPaths siguen exigiendo la revisión humana en el MR.
- **Cómo:** `reviewer.md` sigue con `model: opus`, y la skill pasa `model: "sonnet"` a la herramienta Agent solo en una ronda acotada. En la API de 2.1.304, el `model` de `agent.spawn` es el parámetro de la herramienta Agent, y sin él decide el modelo propio del agente.
- **Vuelta atrás:** si el piloto (fase 4) muestra bloqueantes que pasaron en una ronda acotada, se quita `model` de la skill.

Cambio de la segunda ronda antes del piloto (2026-10-20): una ronda acotada también puede venir después de una revisión sin bloqueantes, cuando se aplicaron sus sugerencias, y va igual en sonnet. El reviewer cita el número de línea del archivo que trae el diff numerado de `review.js`, no la posición dentro del diff (§6.3).

### 6.5 Mod `arnes-mod` (fase 5, dos piezas, nada más)
1. `prompt.compose`: sección `arnes:protocol` (≤ 25 líneas) en el system prompt, `scope: session`.
2. Al cerrar un turno con diff y sin revisión (`classic.Stop` + ledger): `$.agent.spawn({ subagentType: 'arnes:reviewer' })` y el resultado se adjunta al turno. El modelo no decide si se revisa.

Nota para la fase 5 (2026-10-20): la pieza 2 no puede colgarse de `classic.Stop`. En las pruebas de las fases 2b y 3, con 2.1.304, `cc-plugin-sec-default`, un plugin interno del CLI, corre antes y pasa el evento por encima de los hooks de los mods (§3). Un reviewer colgado ahí no corre nunca. Las alternativas:
- **`turn.complete` con `$.agent.spawn`.** Al cerrar el turno del hilo principal con diff y sin revisión vigente, el mod lanza el reviewer y devuelve su reporte en el `{ text }` del turno. `turn.complete` sí corre: `arnes-ui` cierra ahí cada corrida. Pero no bloquea, así que el modelo no ve el reporte hasta el turno siguiente y nadie corrige en ese turno. Además el mod no conoce la carpeta del plugin base (§3): no puede correr `review.js input` ni `mark`. Tendría que repetir la entrada y la huella, y ship no vería esa revisión.
- **El `Stop` clásico exige la revisión, y el mod solo la muestra.** `stop-gate.js` suma una condición (c): un turno que cambió código, con la bandera vigente y sin una revisión del árbol actual (`review.js check`), se bloquea una vez con `falta revisar: /arnes:review`. Es un hook de comando del plugin base, que sí corre, y no depende del orden de la cadena de los mods. Funciona sin el mod (principio 5), y la revisión sigue pasando por la skill, con su entrada, su marca y sus rondas, que es lo que ship comprueba. Como (a) y (b), es un solo bloqueo por turno, y con varias condiciones el motivo las nombra todas. El mod solo pinta `review` pendiente en la banda, como ya pinta el gate.

Recomendación: la segunda. Así `arnes-mod` queda con una sola pieza, el protocolo en `prompt.compose`, y la condición (c) va al plugin base. Se decide al empezar la fase 5, con un dato del piloto: cuánto cuesta revisar cada turno que cambió código, ya con las rondas acotadas (§6.3).

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

Cambio de la segunda ronda antes del piloto (2026-10-20), por la primera corrida real desde la raíz de academico:
- **La cronología es la corrida de la timeline.** El panel dijo "sin etapas en esta corrida" durante toda la corrida, mientras su propia sección Timeline mostraba plan aprobado, build terminado y verify en curso. No era el cwd: la timeline y el mod resolvían la misma raíz. La causa estaba en la corrida del mod, que se cortaba en cada turno del hilo principal. Con los agentes en segundo plano, ese turno cierra apenas los lanza (§3), y la cronología se vaciaba mientras el dev trabajaba. Además, los `tsc` del dev abrían Verificando en pleno build. Ahora:
  - La cronología se calcula de la timeline (`lib.corrida`): desde el último `start plan`, o desde que empezó la sesión si no hubo plan. Trae las etapas cerradas con su duración y su costo, la abierta y la espera de la persona.
  - La corrida se guarda en el historial y se resume en el transcript cuando termina ship, no en cada turno.
  - Las herramientas y los agentes ya no abren etapas. Solo las herramientas del hilo principal marcan las columnas del gate: un `tsc` del dev o un `jest` del test-writer no son el gate. La tabla de señales de arriba queda así: la etapa, de la timeline; los agentes, solo en su lista; los Bash del hilo principal, solo en las columnas.
- **Reloj y costo de la sesión.** La cabecera del panel dice `arnes · <proyecto> · <etapa> · sesión <tiempo> $<costo>`, y la banda termina en `<tiempo> $<costo>`. Salen de `$.session.usage()` (`startedAt` y `cost.usd`), leído con el reloj de 3 s del mod, sin pasar por el modelo.
- **La espera en el panel.** La cronología suma la fila `espera de la persona`, con las notas del turno (§6.2), y `total en etapas` con tiempo y costo. Con una etapa abierta no cuenta la espera en curso, porque mientras un agente trabaja en segundo plano no se espera a nadie. Queda un caso medido de más: si la persona escribe mientras un agente en segundo plano sigue trabajando, ese hueco cuenta como espera.
- **El costo en la timeline.** Al ver el `start` de una etapa, el mod guarda lo que marca `/cost`. Al ver su `end`, agrega a la timeline la nota `{ stage, ws, result: "costo", usd }` con la diferencia. Lo hace con `node -e appendFileSync` por `$.process.run`, porque `$.fs.write` reescribiría el archivo entero y pisaría a una skill que anote en el mismo momento. Es lo único que el mod escribe, y es un dato de medición, no un cambio del flujo. Una etapa que empezó antes de que el mod cargara no lleva costo.
- **Los tokens de cada agente, rotulados.** El agente reportó 57 mil tokens y el panel mostró más de un millón. El panel sumaba `turn.complete.usage` de todos los requests del agente, lecturas de caché incluidas, y cada request vuelve a leer el contexto ya armado. Ahora muestra `<n> tok + <m> de caché`: `tok` es entrada, salida y escritura de caché, y `de caché` son las lecturas de caché.

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

Cambio de la segunda ronda antes del piloto (2026-10-20), por la primera corrida real: adoptar los dos repos de academico costó a mano. Hubo que quitar el hook del arnés anterior del settings, capturar la línea base, escribir `known-failures.txt` con los dieciocho rojos que ya había, poner los permisos, escribir el `CLAUDE.md` de la carpeta, instalar dependencias y descubrir que el jest del front solo imprime el detalle por test con `--reporters=default`. Ahora `/arnes:init`, después de los manifiestos, ofrece lo determinista con `scripts/adopt.js`, y lo que escribe lo corre solo con el sí de la persona:
- `probe`: corre `commands.test` sobre un spec trackeado y comprueba que `test-baseline` lee su detalle. Si no, dice qué flag falta: `--verbose`, o `--reporters=default` cuando ya está `--verbose` y el detalle igual no sale. `adoption-check` hace lo mismo en la comprobación 3.
- `baseline <ws> [--write]`: con el árbol sin código tocado, captura la línea base y agrega a `tests/known-failures.txt`, con la fecha de hoy, los rojos que encontró y no estaban.
- `hooks [--remove]`: los hooks de `.claude/settings.json` del proyecto y de cada repo que corren `.claude/hooks/`. Con `--remove` los quita y deja los demás.
- `permissions [--write]`: el bloque del README armado para el proyecto. Trae la regla de `node` sobre la carpeta del plugin sin su versión, git de lectura, el prefijo de cada comando del manifiesto, con `ask` para `--fix` del lint, graphify y la lectura del issue. Va a `.claude/settings.local.json` de la raíz del proyecto y no al `settings.json`, porque lleva la ruta del plugin en esta máquina y no se commitea. Avisa si git no lo ignora.
- `claude-md [--write]`: en una carpeta multi-repo sin `CLAUDE.md`, el borrador de composición, con los repos, sus comandos, su contrato, la rama y el flujo. Nunca pisa uno existente.

init no instala dependencias ni commitea.

Cambio de la tercera ronda antes del piloto (2026-10-20), por la corrida de un front en su Mac: tenía los repos en su rama de trabajo, que no traía los manifiestos, e init le propuso escribir los dos desde cero, con riskPaths inventadas. Tardaron cuatro intentos en darse cuenta. Ahora, de un repo sin `.claude/harness.json`, `init-draft` (init) y `adoption-check` (init --check) imprimen la rama actual: `api-academico en feature/talleres-view, sin .claude/harness.json`. Si alguna rama remota sí lo trae, la nombran: `origin/fix/adopcion-arnes sí lo trae; cámbiate antes de seguir`. Lo saben con un solo `git cat-file --batch-check` sobre `<rama remota>:.claude/harness.json`, sin checkout (`lib/branches.js` `manifestElsewhere`); las remotas son las del último `git fetch`. En ese caso `init-draft --write` se niega sin `--force`, la skill init se detiene y pide cambiar de rama, y `adoption-check` lo marca como FALTA en la comprobación 1 en vez de NO ADOPTABLE.

Cambio de la tercera ronda antes del piloto (2026-10-20): **los comandos que tocan una base los corre la persona.** El compañero le pidió a la sesión correr `npm run acl:sync`. El `.env` apuntaba a QA, por un proxy en `127.0.0.1:3312`, no a una base local: creó los permisos de talleres, pero desactivó `convenio.desactivar` en QA, porque esa base estaba sincronizada desde otra rama. El manifiesto de api-academico ya lleva en `forbidden` `acl:sync`, `acl:migrar-otorgamientos`, `acl:fusionar-modulos`, `prisma:push`, `prisma:migrate` y `prisma:deploy`. Ahora es general, con `lib/database.js`:
- `init-draft` propone en `forbidden` los scripts del `package.json` cuyo nombre contiene sync, migrate, migrar, push, deploy, seed o reset, o cuyo comando corre una escritura de prisma, typeorm o knex. Propone también esas escrituras si la herramienta está en las dependencias: `prisma migrate dev|deploy|reset|resolve` y `prisma db push|seed|execute`; `typeorm migration:run|revert`, `schema:sync|drop` y `query`; `knex migrate:latest|up|down|rollback` y `seed:run`. Las que solo leen, como `prisma migrate status`, quedan fuera.
- El guard niega esos comandos con su propio motivo: `toca una base: lo corre la persona desde su terminal, sabiendo contra qué base apunta el .env`.
- `adoption-check` da FALTA en la comprobación 3 si alguno no está en `forbidden`.

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

Ronda de correcciones antes del piloto (2026-10-20, rama `feature/pre-piloto`), por la prueba manual y la corrida automática de la fase 3. Cada cambio está en su sección:
- la etapa de arnes-ui sale de la timeline, el rojo lo dice el gate, la línea `Plan:` se limpia y cada agente muestra su costo (§3 y §6.5b);
- plan cierra su etapa al escribir el plan y la espera de la aprobación se mide aparte, y plan y build corren cada comando solo (§6.3);
- las rondas de corrección de review van acotadas, con tope y en sonnet (§6.3 y §6.4);
- la nota para la fase 5 sobre el reviewer determinista (§6.5).

Segunda ronda antes del piloto (2026-10-20, rama `feature/pre-piloto-2`, versión 0.5.2), por la primera corrida real del arnés. Fue desde la raíz de academico, con api-academico (NestJS) y academico-front (Next.js), y un issue full-stack escrito por un front: el CRUD de talleres. Pasó de punta a punta sin un fallo del arnés: plan con criterios y cuatro preguntas con recomendación, build del back y después del front con el contrato, verify con test-writers en paralelo, review sin bloqueantes y con cuatro sugerencias que se aplicaron, una segunda review y `ship --solo-commit` con un commit por repo. En el camino salieron doce cosas que distorsionan la medición o que un front, instalando solo, no sabría sortear. Cada cambio está en su sección:
- la cronología del panel como corrida de la timeline, el reloj y el costo de la sesión, el costo por etapa anotado en la timeline, la espera de la persona y los tokens rotulados (§3 y §6.5b);
- la espera de la persona en toda la corrida y el aviso "verificado, falta review" (§6.2 y §6.3);
- verify y review que no se detienen entre etapas, la review acotada también tras una revisión limpia, el inicio de review anotado después de decidir y las citas con líneas reales (§6.3 y §6.4);
- los diagnósticos de archivos ignorados por git, el commit comparado con la bandera y el aviso sin contract (§6.1);
- lo determinista de init (§8).

Medidas de la corrida, para el piloto (fase 4) y para decidir después: plan 3m27s, build 13m41s, verify 8m30s, review 5m06s y ship 1m55s. La etapa más cara fue review, con dos revisiones completas en opus. La segunda solo revisaba las sugerencias aplicadas, que es lo que ahora va acotado y en sonnet (§6.3).

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
10. Que `test-baseline` lea `jest --json` en vez del texto de `--verbose`. A favor: no depende del reporter de cada config (el front de academico solo daba el detalle con `--reporters=default`), ni de los íconos de Windows, ni del bloque "Summary of all failing tests", y trae el nombre completo de cada test (`ancestorTitles` + `title`). En contra: cambia el `commands.test` de cada manifiesto; conviene escribir el JSON a un archivo con `--outputFile`, para no depender de qué más imprime la corrida por stdout; y vitest y karma tienen su propio formato. Para decidir después del piloto, no ahora.

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
