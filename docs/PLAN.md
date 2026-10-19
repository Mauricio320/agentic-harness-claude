# Plan: arnés multi-proyecto para Claude Code

Fecha: 2026-10-19. Estado: plan aprobado en conversación, sin código aún.
Primer caso real: `C:\Users\MauricioTriana\Desktop\PDV\academico` (tres repos, tres stacks, raíz sin git).
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
- Hooks clásicos: `SessionStart` y `UserPromptSubmit` inyectan `additionalContext` (tope 10.000 chars); `PostToolUse` devuelve contexto o bloquea; `PreToolUse` deniega/reescribe input; `Stop` impide terminar el turno con `decision: block` + `reason` (tiene tope de bloqueos consecutivos: necesita condición de salida); existen `WorktreeCreate` y `WorktreeRemove`. `SessionStart` solo admite `command` y `mcp_tool`.
- Mods (module de function hooks): `prompt.compose` añade secciones al system prompt en cada request; `tool.call` envuelve cualquier herramienta antes y después; `turn.complete` NO bloquea (devuelve `{text}`), pero `classic.Stop` sí es hookeable; `$.agent.register`/`$.agent.spawn` lanzan subagentes desde código; `$.ui` dibuja panel/estado/toasts; `$.model.complete` para clasificaciones baratas. Solo cargan en sesiones locales.
- Worktrees: los de subagentes nacen del branch por defecto salvo `worktree.baseRef: "head"`; se borran solos si no hay cambios y se quedan si los hay; nadie mergea de vuelta automáticamente. En Windows, borrar un worktree no borra lo que apuntan los links. Plugins a nivel de proyecto cargan también en los worktrees.
- Dentro de un worktree, `${CLAUDE_PROJECT_DIR}` de los hooks sigue apuntando al checkout principal; el campo `cwd` del JSON de entrada del hook es el que sigue a Claude. Por eso `lib/manifest.js` resuelve el manifiesto subiendo desde `cwd`, nunca desde `CLAUDE_PROJECT_DIR`.
- El hook `Stop` recibe `stop_hook_active: true` cuando el turno ya continúa por un bloqueo anterior: esa es la condición de salida documentada, no un contador propio. `SubagentStop` es un evento distinto y no se engancha: el gate es del hilo principal.
- Verificado en la fase 0 (2026-10-19): el CLI carga como agente cualquier `.md` dentro de `agents/`, así que esa carpeta no lleva `README.md` (se usa `README.txt`); la forma corta `owner/repo#ref` del comando de instalación siempre apunta a github.com, y en GitLab va la URL completa de clonado; `git mv` solo se registra como rename y el MR solo tiene base si existe un commit inicial en `main` antes de ramificar. Además, los usuarios reciben una versión nueva solo cuando cambia `version` en `plugin.json`: pushear sin subirla no llega a nadie, y `version` no se declara también en la entrada del marketplace porque `plugin.json` gana y `validate` avisa del desfase.

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
        init-draft.js                    # detección determinista de arnes:init: repos, stack, comandos, specPattern; escribe los dos niveles de §5
        touched-files.js                 # modificados + untracked por workspace
        typecheck-baseline.js            # foto y diff por diagnóstico (parser tsc; interfaz para otros)
        test-select.js                   # deriva specs de archivos tocados según specPattern
        merged-files.js                  # intersección real tras un merge
        worktree-ledger.js               # registro de worktrees por issue; pendientes de integrar
        gate-flag.js                     # escribe/valida la bandera de verificación
        adoption-check.js                # las 6 comprobaciones del mínimo
        ci-gate.js                       # lo que corre el CI: touched-files + typecheck + lint + test-select sobre el MR
        hooks/{session-start,prompt-context,after-edit,guard,stop-gate,worktree-remove}.js
      tests/                             # repos de juguete + node --test; corre en CI del arnés
    arnes-ui/
      .claude-plugin/plugin.json         # solo interfaz: banda, panel, status, toasts (§6.5b)
      hooks/hooks.json                   # { "modules": ["./register.tsx"] }
      hooks/register.tsx
      types/index.d.ts
    arnes-mod/
      .claude-plugin/plugin.json         # comportamiento: depende de arnes
      hooks/hooks.json                   # { "modules": ["./register.ts"] }
      hooks/register.ts                  # prompt.compose + reviewer determinista
      types/index.d.ts
  .gitlab-ci.yml / .github/workflows     # validate + tests + plugin test contra versión fijada del CLI
```

Todo en Node (sin bash, sin jq): el equipo está en Windows y los hooks tienen que correr igual en PowerShell, Git Bash y CI.

Política de invocación de las skills (es el mecanismo de "se comporta sin invocarlo"): `plan`, `verify`, `review`, `memory` y `timeline` quedan invocables por el modelo (sin `disable-model-invocation`), con descripciones que empiezan por las palabras de un pedido real ("implementar", "corregir", "revisar"); `init`, `ship`, `worktree` y `sync` llevan `disable-model-invocation: true` porque mueven ramas o crean archivos y las dispara solo la persona. Los agentes del plugin ignoran `hooks`, `mcpServers` y `permissionMode` en su frontmatter (restricción documentada de los plugins), así que todo control sobre ellos va por los hooks del plugin, no por el agente.

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
- `worktree-ledger.js`: ver §7.
- `gate-flag.js write <ws>` escribe `.tmp/harness/gate/<ws>.json` = `{ head, touchedHash, result, at }`; `check <ws>` valida vigencia (mismo HEAD, mismo hash de la lista de tocados, < 30 min). Sin huella del contenido del árbol: el CI es quien garantiza la honestidad, no el marcador.
- `adoption-check.js`: manifiesto válido; `CLAUDE.md` presente; lint y typecheck ejecutables; CI con el job del gate; rutas de riesgo declaradas; versión del plugin fijada. Un repo de la composición sin manifiesto propio sale como "no adoptable todavía" y no bloquea.
- `ci-gate.js`: el base es `--base`, o `CI_MERGE_REQUEST_DIFF_BASE_SHA` en GitLab, o el merge-base con `origin/<defaultBranch>`. La foto de typecheck del base sale de `git archive <base>` a un directorio temporal, que no toca `.git` ni crea worktrees ni ramas, con el `node_modules` del workspace enlazado: symlink en CI (Linux), junction en Windows local, o copia si no se puede crear el enlace. Se compara contra el árbol actual con la misma clave y los mismos conteos que `typecheck-baseline`. Después corre lint sobre los tocados que caen en `codeGlobs` y los tests que elige `test-select`. Cachear la foto por SHA del merge-base queda como mejora posterior, fuera de la fase 1.

### 6.2 Hooks clásicos (`hooks/hooks.json`)
| Evento | Script | Hace |
|---|---|---|
| `SessionStart` | `session-start.js` | Lee el manifiesto; imprime workspaces, rama de cada uno, árbol sucio, worktrees pendientes de integrar (§7), últimas 5 decisiones de `docs/decisions`; inyecta el protocolo en ≤ 40 líneas. Si no hay manifiesto, dice cómo crearlo y no inventa nada |
| `UserPromptSubmit` | `prompt-context.js` | Adjunta estado corto (rutas de riesgo tocadas, bandera vigente o no). Nunca bloquea |
| `PostToolUse` (`Edit\|Write`) | `after-edit.js` | Lintea solo el archivo editado (segundos) y devuelve los hallazgos como `additionalContext`. Corre typecheck solo si el workspace declara `commands.typecheckFast` (incremental), con debounce de 20 s por workspace; sin esa variante, el typecheck completo se deja para `verify`, porque un `tsc` de un minuto tras cada edición destruye la sesión. Nunca bloquea |
| `PreToolUse` (`Bash\|PowerShell`) | `guard.js` | Parsea el comando por segmentos (`&&`, `;`, `\|`, saltos) y solo juzga segmentos que empiezan por el ejecutable. Deniega: `git reset --hard`, `push --force`, `clean -f`, `branch -D` de ramas con commits sin mergear; comandos de `forbidden`; `git commit` sin bandera vigente para ese workspace; `git add .` con `.env`/logs sin trackear. Nunca mira texto de heredocs ni argumentos de `echo`/`cat` |
| `Stop` | `stop-gate.js` | Bloquea terminar si (a) hay cambios en archivos de `codeGlobs` sin bandera de verificación vigente, o (b) hay worktrees del issue con commits sin integrar. Un solo bloqueo por turno: si la entrada trae `stop_hook_active: true`, deja pasar con aviso visible y escribe el pendiente en la timeline. No engancha `SubagentStop`. No bloquea si no hay manifiesto |
| `WorktreeRemove` | `worktree-remove.js` | Rechaza borrar un worktree cuya rama tenga commits no contenidos en su rama destino del ledger |

### 6.3 Skills (lo que requiere juicio, corto)
- `plan`: lee el issue (gh/glab o texto), consulta graphify si existe (`/graphify query`) en vez de barrer el repo, produce `.tmp/harness/plan.md` con: criterios literales e inferidos, contrato (ruta, request, response, roles), tablas y migraciones, zonas de riesgo tocadas, preguntas cerradas con recomendación. Pide confirmación. Escrito para que lo apruebe alguien que no conoce el stack.
- `build`: un `dev` por workspace, back antes que front; el contrato del back viaja textual al front; desviaciones del plan declaradas.
- `verify`: scripts del §6.1 sobre los workspaces tocados; `test-writer` solo si hay código nuevo sin spec; escribe la bandera. Reporta "verde = compila y testea".
- `review`: `reviewer` una vez sobre el árbol final, con el plan y la lista de tocados; sección de cumplimiento de criterios; si toca `riskPaths`, marca `REVISIÓN HUMANA OBLIGATORIA` en el reporte y en el cuerpo del MR.
- `ship`: misma rama en todos los workspaces tocados, commits back → front, push y MR/PR cruzados; se niega si el ledger tiene worktrees abiertos del issue; convención de commits del repo (lee `commitlint`/`CLAUDE.md`).
- `worktree`: §7.
- `memory`: `decision` escribe `docs/decisions/YYYY-MM-DD-<slug>.md` (qué, por qué, alternativa descartada); `gotcha` añade a `docs/gotchas.md`; `recall` consulta esos archivos y graphify. Sin MCP.
- `sync`: versión de 60 líneas del `sync-branch` actual: respaldo, fetch, merge contra `origin/<rama>`, `merged-files`, verify.
- `timeline`: imprime `.tmp/harness/timeline.jsonl` como texto, con duración por etapa. Cada skill anota su inicio y su fin con `lib/timeline.js`, así la medición existe aunque `arnes-ui` no esté instalado (CI, otra máquina, sesión sin mods); el mod solo la dibuja.

### 6.4 Agentes
`dev` (sonnet, Read/Write/Edit/Bash/Glob/Grep; lee `CLAUDE.md` y rules del workspace; no escribe tests; devuelve contrato resultante y criterios cubiertos con `archivo:línea`), `reviewer` (opus, solo lectura; lista cerrada de bloqueantes tomada de `.claude/rules/*` del repo + genéricas: contrato back/front, transacción multi-tabla, migración sin down, criterio no implementado, string de negocio mágico, secreto en código), `test-writer` (sonnet), `test-runner` (haiku; rojos preexistentes por ruta y nombre desde `tests/known-failures.txt` del repo si existe). El clasificador desaparece: el orquestador decide si hace falta plan.

### 6.5 Mod `arnes-mod` (fase 5, dos piezas, nada más)
1. `prompt.compose`: sección `arnes:protocol` (≤ 25 líneas) en el system prompt, `scope: session`.
2. Al cerrar un turno con diff y sin revisión (`classic.Stop` + ledger): `$.agent.spawn({ subagentType: 'arnes:reviewer' })` y el resultado se adjunta al turno. El modelo no decide si se revisa.

Lo visual no va aquí: vive en `arnes-ui` (§6.5b), que no cambia comportamiento y se puede desactivar sin tocar el flujo.

### 6.5b Mod de interfaz `arnes-ui` (solo muestra, nunca cambia el comportamiento)

Plugin aparte de `arnes-mod`, para que lo visual no comparta destino con lo que gobierna el flujo. Regla única: cada hook observa y devuelve `next(e)` sin tocar nada; si el mod falla, el arnés sigue igual.

Qué muestra:
- **Etapa actual** y su cronología: `Leyendo issue → Planeando → Construyendo (dev api) → Verificando (tsc api, jest 12 specs) → Revisando → Entregando → Guardando memoria`, con duración y costo por etapa (de `turn.complete.usage`).
- **Agentes vivos**: nombre, modelo, tiempo transcurrido, última herramienta que usó, botón "ver" que cambia la vista a su transcript (`$.ui.view({ agentId })`, válido porque lo pulsa la persona).
- **Gate por workspace**: rama, árbol sucio/limpio, typecheck ✓/✗/⏳, tests ✓/✗/⏳, review ✓/✗/⏳, bandera vigente o vencida, worktrees abiertos sin integrar.
- **Avisos** como toasts: cambio de etapa, gate en rojo, reviewer terminó con N hallazgos, Stop bloqueado y por qué, zona de riesgo tocada → revisión humana obligatoria.
- **Lo que sigue**: una línea ("falta integrar wt/feature-X/front", "listo para /arnes:ship").

De dónde saca la etapa, sin adivinar por texto:
| Señal | Evento del mod | Etapa |
|---|---|---|
| Se carga una skill `arnes:*` | `skill.prompt` | la que diga el nombre de la skill |
| Se lanza un subagente `arnes:dev` / `arnes:reviewer` / `arnes:test-writer` | `agent.spawn`, y `turn.complete` con `agentId` cuando termina | Construyendo / Revisando / Escribiendo tests |
| Bash con los scripts del arnés o con el `test` del manifiesto | `tool.call` + `process.spawn` (salida en streaming) | Verificando, con progreso real |
| `Edit`/`Write` | `tool.call` | contador de archivos tocados por workspace |
| Request al modelo en vuelo | `turn.step` | "Pensando…" |
| Archivos de estado `.tmp/harness/{plan.md,gate/*.json,worktrees.json}` | `$.fs` leído en cada evento relevante y `$.clock.every(3s)` | tabla del gate y worktrees |
| Compactación | `session.compact` | aviso "contexto compactado" |

Superficies: una **banda sobre el prompt** (`ui.render` de `AbovePrompt`), siempre visible a cualquier ancho, una línea: `arnes ▸ Revisando · reviewer opus 00:42 · api ✓tsc ✓tests ⏳review · front ✓tsc ✗tests · 2 wt sin integrar`. Un **panel** (`$.ui.open` + `ui.render` de `Pane`) con la cronología, los agentes y la tabla del gate; en terminal se asienta a partir de 144 columnas si lo abre el mod, o a cualquier ancho si lo abre la persona con `/arnes:panel`. Una **entrada en la status line** (`$.ui.status`) con la etapa. Misma árbol en desktop y VS Code vía `$.ui.resolve(e)`.

Estado: átomos en `$.state` declarados en `types/index.d.ts` (etapa, cronología, agentes, gate por workspace); `$.store` guarda las últimas 20 corridas (issue, duración y costo por etapa, resultado) para un mini historial en el panel.

Motivo declarado por el usuario: ver visualmente en qué etapa se va el tiempo, y hacer la sesión más interactiva. Por eso, al cerrar cada corrida el mod imprime un resumen por etapa (`plan 2m · build 9m · verify 4m · review 6m · ship 1m`) marcando la más lenta y la más cara, y el panel muestra el promedio de las últimas corridas por etapa para distinguir una demora puntual de un cuello de botella estructural (por ejemplo, el reviewer en opus llevándose el 40 % siempre). Esa medición es también la entrada para decidir qué pieza del arnés quitar o abaratar. Comandos: `/arnes-ui:panel` abre o cierra (el prefijo es el del plugin que lo registra); `/arnes:timeline` vive en el plugin base y funciona sin el mod. La fuente de verdad de la cronología es `.tmp/harness/timeline.jsonl`, escrita por las skills; el mod la lee y le suma lo que solo él ve (agentes vivos, requests en vuelo, costo por `turn.complete.usage`).

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
6. **Cuándo no usar worktrees**: si los agentes tocan archivos disjuntos, corren en el mismo árbol, secuenciales o en paralelo, sin ramas: cero integración. Worktrees solo cuando habría conflicto real.
7. **Limpieza**: `worktree prune` + barrido en `SessionStart` de worktrees con más de 7 días sin commits nuevos → aviso, nunca borrado silencioso.
8. `.worktreeinclude` con `.env` en cada repo para que los worktrees arranquen con entorno.

Nota: Claude Code trae `/batch`, donde cada subagente trabaja en su worktree y abre su propio PR. Sirve cuando las tareas son issues independientes; no para partes de un mismo issue, que es el caso de este diseño.

## 8. Mínimo de adopción (lo comprueba `arnes:init --check`)

1. `.claude/harness.json` válido contra el schema.
2. `CLAUDE.md` con reglas duras del stack (≤ 200 líneas) y `.claude/rules/` con `paths:`.
3. Typecheck y lint ejecutables sin `--fix`.
4. Job de CI que corre `ci-gate.js` (los mismos scripts) y bloquea el MR si falla; el host git configurado con "merge solo si el pipeline pasa", squash al mergear a `main`, y detección de secretos activada (GitLab Secret Detection o equivalente en Bitbucket).
5. `riskPaths` declaradas y regla de aprobación en el host git: GitLab, approval rules por patrón de archivo o `CODEOWNERS` (según plan; en Free: rama protegida + pipeline obligatorio + plantilla de MR con el revisor); Bitbucket, default reviewers + restricciones de rama.
6. Plugin fijado a un tag en `~/.claude/settings.json` o en `.claude/settings.json` del repo.

El README del arnés trae además la lista de permisos recomendada para `~/.claude/settings.json` (los `node` de los scripts del plugin, `git` de lectura, los comandos de test del manifiesto), para que el flujo no se detenga en diálogos de permiso; sin ella el arnés funciona, pero pregunta.

## 9. Versionado y compatibilidad

- Tags semver en `agentic-harness`; un tag cubre los tres plugins (`arnes`, `arnes-ui`, `arnes-mod`). `CHANGELOG.md`.
- Instalación: `claude plugin install arnes --marketplace <fuente>#vX.Y.Z` (user scope), donde `<fuente>` depende del host: la forma corta `owner/repo` es solo para GitHub; en GitLab u otro host va la URL completa de clonado, `https://gitlab.com/preupdv/apps/agentic-harness.git#vX.Y.Z` (o `git@gitlab.com:<grupo>/agentic-harness.git`). `arnes-ui` y `arnes-mod` se instalan aparte, por nombre, desde el mismo marketplace. El host se elige donde el equipo que lo va a instalar ya tiene credenciales: para academico, GitLab (`preupdv`), y el CI es `.gitlab-ci.yml`. Auto-update apagado. Rollback = re-añadir el marketplace en el tag anterior. Desinstalar: `claude plugin uninstall <nombre>@agentic-harness`.
- README con matriz tag ↔ versiones de Claude Code probadas. CI del arnés: `claude plugin validate` sobre los tres, tests de scripts con repos de juguete (`node --test`), `claude plugin test` para los mods, y más adelante `claude plugin eval`.
- El equipo sube CLI y arnés juntos, nunca uno solo.

## 10. Fases y criterio de salida

| Fase | Entregable | Sale cuando |
|---|---|---|
| 0 | Repo con marketplace + tres plugins vacíos, README con principios, permisos y matriz, `docs/PLAN.md`, CI con `validate` | `claude plugin validate` pasa en los tres y `claude --plugin-dir ./plugins/arnes` carga y muestra `/arnes:init` |
| 1 | Schema + manifiesto + `init` + `touched-files`, `typecheck-baseline`, `test-select`, `gate-flag`, `adoption-check`, `ci-gate`, `lib/timeline` con tests de juguete | Los scripts pasan en academico (3 ws) y en renova365 (2 ws); `ci-gate` corre en un pipeline real |
| 2 | Hooks clásicos: `guard` → `after-edit` → `session-start` → `stop-gate` → `worktree-remove` | Una sesión normal en api-academico lintea sola tras editar y no deja commitear sin bandera; el `Stop` bloquea una vez y suelta con `stop_hook_active` |
| 2b | `arnes-ui`: banda, panel, status, toasts, `/arnes-ui:panel`; `/arnes:timeline` en el plugin base | Muestra etapa, agentes y gate en una sesión real; desactivado, nada cambia y la timeline sigue existiendo |
| 3 | Skills `plan/build/verify/review/ship/memory/sync` + 4 agentes + `worktree` con ledger | Un issue real de api-academico de punta a punta, sin invocar comandos |
| 4 | Piloto: un issue de back de patrón conocido hecho por un dev de front con el arnés | Cuatro números anotados: hallazgos del reviewer, hallazgos del humano en el plan, defectos que llegaron a QA, minutos por etapa según la timeline |
| 5 | `arnes-mod` (protocolo en system prompt, reviewer determinista) | Funciona y, desactivado, el plugin sigue completo |
| 6 | graphify por repo, memoria en markdown, script de setup por carpeta, migración de renova365 y api-academico (borrar sus `.claude/` viejos, limpiar worktrees huérfanos, quitar permisos de push, sacar la contraseña de `settings.local.json`) | Las tres carpetas corren el mismo tag |

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

Abiertas:
3. Plan de GitLab del equipo (define si hay approval rules por patrón o se usa la vía Free).
4. Graphify: solo código al principio; cuándo activar la pasada semántica de docs.
5. Qué issue y qué persona para el piloto de la fase 4.
6. Si `academicoBitbuckett` (PHP) entra en la fase 1 o se deja como workspace "solo lectura" hasta tener lint y tests.
7. El `CLAUDE.md` global del usuario exige Engram en toda sesión; cuando la memoria pase a markdown (fase 6) hay que reescribir ese archivo, o Engram seguirá siendo obligatorio por instrucción aunque el arnés no lo use.

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
