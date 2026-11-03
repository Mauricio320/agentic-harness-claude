# agentic-harness

Arnés multi-proyecto para Claude Code: un marketplace con el plugin `arnes` y dos mods opcionales, `arnes-ui` (interfaz) y `arnes-mod` (comportamiento). Hace que cualquier sesión, en cualquier proyecto, siga el mismo flujo (plan → build → verify → review → ship) con verificación determinista y revisión humana obligatoria en zonas de riesgo. El diseño completo está en [docs/PLAN.md](docs/PLAN.md).

Estado: versión 0.8.2, tag `v0.8.2`, desde la rama `fix/0.8.2-ruido-y-trabas`. Lo que trae cada versión está en `CHANGELOG.md`, la guía para probarla en `docs/PROBADORES.md`, y la versión de Claude Code con que se probó en `plugins/arnes/compat.json`. Hoy existen:
- los manifiestos, uno por repo y una composición por carpeta multi-repo, y el repo de carpeta que los versiona;
- los scripts deterministas y los hooks clásicos;
- las doce skills: `/arnes:init`, `setup`, `plan`, `build`, `verify`, `review`, `ship`, `worktree`, `memory`, `sync`, `timeline` y `cerrar`;
- los tres agentes: `dev`, `reviewer` y `test-writer`;
- cada issue en un worktree nativo de Claude Code, también en una carpeta multi-repo, con su registro, su rescate de lo que queda sin commitear y su ciclo hasta main;
- el carril corto: un pedido chico lleva un plan corto que se aprueba por reglas y se construye en el hilo principal;
- el mod `arnes-ui`, y el mod `arnes-mod` con dos piezas: la cuarta capa del plan obligatorio y el modelo fijo de cada agente.

Falta el piloto con otra persona (fase 4) y el resto de `arnes-mod` (fase 5).

## Principios

1. Cada pieza existe porque el modelo no lo hace solo. Cuando un modelo nuevo lo haga, la pieza se quita.
2. Lo que debe cumplirse siempre va a una herramienta (lint, tsc, tests, hook, CI, aprobación en el host git). Lo que requiere juicio va en prosa corta. Lo demás se borra.
3. Nada del stack queda cableado en el arnés: todo lo específico se lee del manifiesto del proyecto y de su `CLAUDE.md`.
4. El verde del arnés significa "cumple convenciones y compila/testea", nunca "es correcto en el negocio". Se dice así una vez por corrida (principio 7).
5. El plugin funciona completo sin el mod. El mod es opcional y delgado.
6. Presupuesto: ninguna skill supera ~80 líneas; ningún agente supera ~120; el `CLAUDE.md` raíz de un proyecto no supera 200.
7. La voz del arnés. Quien lee el chat puede no conocer el arnés, y un reporte largo con salidas de scripts, rutas y hashes lo abruma. De cada skill lee como máximo una línea de qué pasó y una lista corta de lo que tiene que decidir o hacer, sin nombres de scripts, códigos de salida, hashes ni rutas del plugin. El detalle completo (la salida del gate tal cual, la lista de archivos, los motivos) va a `.tmp/harness/informes/<etapa>-<hora>.md`, y el chat dice su ruta en una línea; `arnes-ui` muestra lo vivo. Quedan en el chat, textuales, los bloqueantes del reviewer, que la persona tiene que ver, y las preguntas del plan con su recomendación. La frase "verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio" sale una sola vez por corrida, no en cada reporte. Las preguntas de cualquier skill van en un solo bloque numerado, cada una con su recomendación, contestable con "sí a todo". init no pregunta: decide y lo dice al cerrar.

## Lo que existe porque el modelo no lo hace solo

El principio 1 obliga a quitar cada pieza cuando un modelo la haga sola. Para que eso ocurra y no quede en promesa, estas son las piezas que compensan al modelo, cada una con lo que se observa en el piloto para retirarla (`docs/PROBADORES.md` §10). Lo que compensa a la herramienta (los permisos por prefijo, un evento que los mods no ven) o protege a la persona (git destructivo, secretos, la aprobación que exige su respuesta, la bandera que escribe solo la verificación) no entra en la lista: no depende de lo que el modelo haga.

| Pieza | Compensa que | Se retira cuando |
|---|---|---|
| `arnes-mod`, cuarta capa del plan: haiku decide si el mensaje pide código y le adjunta «carga arnes:plan» | el modelo escribía código sin plan hasta que el guard lo negaba | en un issue del piloto sin el mod, el modelo carga el plan solo, antes o justo después de la primera negativa |
| Stop (c): el código escrito por el shell sin plan aprobado | el modelo rodeaba el guard de Edit con `sed -i`, `Set-Content` o `node -e` | ningún turno bloqueado por (c) en el piloto |
| Stop (e): el plan aprobado sin build en el mismo turno | el modelo se quedaba esperando un «construye» | ningún turno bloqueado por (e) en el piloto |
| build abre dos o tres líneas que el dev cita en su cobertura | el dev citaba `archivo:línea` que no decían lo que afirmaba | el reviewer no reporta una cita falsa en el piloto |
| `arnes-mod` niega un agente `arnes:*` lanzado con `model` o `effort` distintos a su definición | el orquestador pasaba `model` en Agent y pisaba la definición | ningún lanzamiento negado en el piloto |

Una pieza que se retira sale con su test y su línea en esta tabla, y el changelog la anota bajo «Quitado».

## Instalación

El repo vive en GitLab. El formato corto `owner/repo` siempre apunta a github.com, así que se instala con la URL completa y el tag al final:

```
claude plugin install arnes --marketplace https://gitlab.com/preupdv/apps/agentic-harness.git#vX.Y.Z
claude plugin install arnes-ui@agentic-harness
claude plugin install arnes-mod@agentic-harness
```

El primer comando añade el marketplace `agentic-harness` fijado a ese tag (scope `user`) e instala `arnes`. Los otros dos son opcionales e independientes; `arnes-mod` declara `arnes` como dependencia. `arnes-ui` se ve solo en la terminal: no en el chat de la extensión de VS Code ni en el de Claude Desktop, y en los dos sirve la terminal integrada. Claude Code clona con `git` sin preguntar credenciales: la credencial de GitLab tiene que estar guardada de antemano (Git Credential Manager) o, por SSH, usar `git@gitlab.com:preupdv/apps/agentic-harness.git#vX.Y.Z` con la clave cargada en el agente.

Para fijar la versión en un proyecto, en el `.claude/settings.json` de su repo de carpeta (abajo), o en el del repo si es de un solo repo. En una carpeta lo escribe `adopt.js folder-settings`, con los tres plugins y fijado a `main`, donde se publica cada versión (`--ref vX.Y.Z` para un tag):

```json
{
  "extraKnownMarketplaces": {
    "agentic-harness": {
      "source": { "source": "git", "url": "https://gitlab.com/preupdv/apps/agentic-harness.git", "ref": "vX.Y.Z" }
    }
  },
  "enabledPlugins": { "arnes@agentic-harness": true, "arnes-ui@agentic-harness": true, "arnes-mod@agentic-harness": true }
}
```

### El repo de carpeta

Un proyecto de varios repos versiona su composición en un repo chico propio, el repo de carpeta. Lleva la composición `.claude/harness.json`, con el `remote` y la `branch` de cada repo, el `CLAUDE.md` de la carpeta, el `.claude/settings.json` de arriba y un `.gitignore` que ignora las carpetas de los repos, `.tmp/`, `.claude/settings.local.json`, `.claude/worktrees/` y `graphify-out/`. Los repos de verdad se clonan dentro, y git los ignora. Lo arma `/arnes:init` la primera vez. Quien llega después instala los plugins y corre `/arnes:setup <url del repo de carpeta>`: clona todo en su rama, instala dependencias, prepara el `.env` sin inventar valores y cierra con lo que queda pendiente de la persona (`docs/PROBADORES.md` §2).

### Los worktrees

Cada issue se trabaja en un worktree nativo de Claude Code, siempre desde main al día: al aprobar el plan, la sesión se mueve a uno con EnterWorktree (o la persona la abre con `claude --worktree <nombre>`, o el escritorio en modo worktree), y los checkouts de la persona no se tocan. En una carpeta multi-repo, el repo de carpeta tiene su worktree, y el arnés trae adentro cada repo del plan como un worktree de git en la rama del issue. Lo que un repo tenga sin commitear se guarda después de cada turno en un ref del propio repo (`refs/arnes/rescate/<nombre>`), y mientras haya algo sin commitear o sin subir, un archivo `.arnes-trabajo-pendiente` hace que Claude Code pregunte antes de borrar el worktree; si igual se borra, el arnés lo avisa y `/arnes:cerrar` lo recupera, con el worktree de carpeta entero. Cada uno nace usable: `node_modules` enlazado al del checkout principal (junction en Windows, symlink en el resto), copias propias de los `.env*` salvo `.env.example`, y los puertos desplazados, 10 por worktree, con el front apuntando al back del mismo worktree (`api 3003 → 3013, front 3000 → 3010`). "Inicia la app" la levanta desde el worktree con esos puertos en el entorno del proceso, y "para la app" la para; el arnés también la para antes de borrar el worktree, y solo para lo que levantó él. Al salir con "remove", el arnés quita primero los enlaces y el worktree de cada repo; las ramas del issue quedan. La rama en el checkout es la alternativa, o el camino por defecto con `integration.workInPlace`. Cuando dos devs del mismo build chocarían en los mismos archivos, build lanza al segundo con `isolation: worktree` y Claude Code le da su propio worktree, que el arnés integra en la rama del issue al terminar.

El auto-update de un marketplace de terceros viene apagado y se deja así.

Cambiar de tag, para subir o para volver atrás, es quitar el marketplace y añadirlo en el otro tag. `claude plugin marketplace remove agentic-harness` desinstala los plugins que vinieron de él, así que después se reinstalan con los comandos de arriba. Desinstalar un plugin suelto: `claude plugin uninstall <nombre>@agentic-harness`.

Probar sin instalar, desde la raíz del repo:

```
claude plugin validate --strict plugins/arnes
claude --plugin-dir ./plugins/arnes
claude --plugin-dir ./plugins/arnes --plugin-dir ./plugins/arnes-ui
claude plugin test plugins/arnes-ui
claude plugin test plugins/arnes-mod
```

## Permisos recomendados

Los hooks no piden permiso: corren fuera del sistema de permisos. Lo que sí pide confirmación son los comandos que el modelo lanza por Bash o PowerShell: los scripts del plugin que invocan las skills, git de lectura y los comandos de test del manifiesto. Sin estas reglas el arnés funciona igual, pero pregunta. Van en `~/.claude/settings.json`, o en `settings.json` del directorio que indique `CLAUDE_CONFIG_DIR`:

```json
{
  "permissions": {
    "allow": [
      "Bash(node \"C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/*)",
      "PowerShell(node \"C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/*)",
      "Bash(git status *)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git rev-parse *)",
      "Bash(git ls-files *)",
      "Bash(git merge-base *)",
      "Bash(npx tsc --noEmit *)",
      "Bash(npx tsc -p *)",
      "Bash(npx jest *)",
      "Bash(npx eslint *)",
      "PowerShell(npx jest *)",
      "PowerShell(npx eslint *)",
      "Bash(graphify query *)",
      "Bash(graphify explain *)",
      "Bash(graphify path *)",
      "Bash(glab issue view *)",
      "Bash(gh issue view *)"
    ],
    "ask": [
      "Bash(npx eslint *--fix*)",
      "PowerShell(npx eslint *--fix*)"
    ]
  }
}
```

Cómo leerlas (sintaxis de code.claude.com/docs/en/permissions):
- **El `*` admite cualquier texto, espacios incluidos, y lo que va antes se compara tal cual.** La ruta del plugin es la de la caché (`<config>/plugins/cache/<marketplace>/<plugin>/<versión>/`), con barras normales, porque Claude Code sustituye `${CLAUDE_PLUGIN_ROOT}` así también en Windows. El `*` después de `arnes/` cubre la versión y el script; un `..` dentro de la ruta escaparía de esa carpeta, así que la regla confía en que los comandos sean los de las skills. Con `CLAUDE_CONFIG_DIR` la raíz cambia (por ejemplo `.claude-pdv`), y con `claude --plugin-dir` la ruta es la del repo del arnés.
- **Las formas de git de lectura sin `cd` ni `-C` ya corren sin preguntar.** Estas reglas cubren las que no: `git -C <ruta> status` no las cumple, porque el patrón compara el texto desde el inicio.
- **`Bash(npx eslint *)` también dejaría pasar un `--fix`.** Por eso va la regla `ask`, que se evalúa antes que `allow` y obliga a preguntar.
- **graphify y la lectura del issue son de solo lectura.** `/arnes:plan` y `/arnes:memory recall` consultan graphify con `query`, `explain` y `path`, y plan lee el issue con `glab issue view` o `gh issue view`. Los scripts nuevos de la fase 3 ya los cubre la regla de `node` sobre la carpeta del plugin. `git commit` y `git push` quedan fuera a propósito: los corre `/arnes:ship`, que pide confirmación antes de cualquier push.
- **Los comandos de test son los de los manifiestos de academico.** Ajústalos a los `commands` de cada repo y no agregues comodines más amplios que el comando real.

## Versionado en dos capas

1. **Tag del repo `vX.Y.Z`** (semver). Es lo que el equipo fija: `#vX.Y.Z` en la instalación o `ref` en settings. Un tag cubre los tres plugins, y cada tag tiene su entrada en `CHANGELOG.md`.
2. **`version` en el `plugin.json` de cada plugin**, igual al tag en los tres. Claude Code compara este campo para decidir si hay versión nueva: si el código cambia y el campo no, nadie recibe el cambio. Las entradas de `marketplace.json` no llevan `version`; si la llevaran, ganaría `plugin.json` y `validate` avisaría del desfase. Pushear código sin subir `version` no llega a nadie: Claude Code compara ese campo, no los commits.

3. **`claudeCode` en `plugins/arnes/compat.json`**, la versión de Claude Code con que se probó el tag. Es la que instala el CI y la que la sesión compara al arrancar. Subirla sin tocar la matriz de abajo ni `docs/PROBADORES.md` no pasa los tests: así los tres no vuelven a desfasarse.

No se usan los tags por plugin `<nombre>--v<versión>`: solo hacen falta para resolver rangos de versión entre dependencias, y `arnes-mod` depende de `arnes` sin rango.

## Matriz de compatibilidad

CLI y arnés se suben juntos, nunca uno solo. La versión del CLI probada vive en `plugins/arnes/compat.json`: el CI instala esa, `tests/compat.test.js` exige que la última fila de esta matriz y `docs/PROBADORES.md` digan la misma, y al arrancar una sesión con una versión más nueva el arnés lo dice en una línea, para que una falla rara se atribuya a la versión y no al flujo.

| Tag del arnés | Claude Code probado | Node probado | Notas |
|---|---|---|---|
| v0.1.0 | 2.1.303 | 24 | Fase 0: marketplace y tres plugins vacíos; `/arnes:init` es un esqueleto |
| v0.2.0 (sin etiquetar) | 2.1.303 | 24 | Fase 1: schema de los dos niveles de manifiesto, scripts deterministas con tests (`node --test`) y `/arnes:init` completa; probado en academico (3 repos) y renova365 (2 repos) |
| v0.3.0 (sin etiquetar) | 2.1.303 | 24 | Fase 2: hooks clásicos (guard, after-edit, session-start, prompt-context, stop-gate, worktree-remove) con tests por stdin; la prueba manual en una sesión interactiva está en `docs/PRUEBA-FASE-2.md`, hecha en api-academico el 2026-10-19 |
| v0.4.0 (sin etiquetar) | 2.1.303 (tipos de la API de mods) y 2.1.304 (`validate` y `plugin test`) | 24 | Fase 2b: mod `arnes-ui` (banda, panel con `/arnes-panel`, status, toasts) con tests de `claude plugin test`, y `/arnes:timeline` en el plugin base; la prueba manual está en `docs/PRUEBA-FASE-2B.md`, hecha y repetida en api-academico y desde la raíz de academico el 2026-10-19 con 2.1.304; fase cerrada |
| v0.5.0 | 2.1.304 | 24 | Fase 3: plan, build, verify, review, ship, worktree, memory y sync, los agentes dev, reviewer, test-writer y test-runner, el registro de worktrees, la línea base de tests y el aviso de sesión concurrente. Probada de punta a punta sobre un clon de api-academico el 2026-10-20, con `claude -p` y en una sesión interactiva; la prueba manual está en `docs/PRUEBA-FASE-3.md`; fase cerrada |
| v0.5.1 (sin etiquetar) | 2.1.304 | 24 | Ronda antes del piloto, por la prueba manual de la fase 3: la etapa de arnes-ui sale de la timeline, el rojo lo dice el gate, la espera de la aprobación del plan se mide aparte y las rondas de review van acotadas y con tope; guía `docs/PROBADORES.md` |
| v0.5.2 (sin etiquetar) | 2.1.304 | 24 | Segunda ronda antes del piloto, por la primera corrida real desde la raíz de academico: la cronología es la corrida de la timeline, con reloj, costo por etapa y espera de la persona; review acotada también tras una revisión limpia; ship compara el commit con la bandera; init hace lo determinista de la adopción |
| v0.5.3 (sin etiquetar) | 2.1.304 | 24 | Tercera ronda antes del piloto, por la corrida de un front en Mac: el plan es obligatorio (guard sobre Edit y Write, aprobación de la persona, `/arnes:plan --trivial`), el aviso de un agente no abre turno, init dice la rama que trae el manifiesto, los comandos contra una base van a `forbidden` y las convenciones mecánicas entran al gate |
| `arnes-mod` desde v0.5.3 (sin etiquetar) | 2.1.305 como mínimo | 24 | Primera pieza del mod de comportamiento: `prompt.submit` pregunta a haiku con `$.model.complete` si el mensaje pide un cambio de código y, sin plan en curso, adjunta con `context` la instrucción de cargar `arnes:plan`. Probado en una sesión real con 2.1.305; con 2.1.304 no se probó. Falla abierto, y sin el mod las tres capas del plugin base siguen |
| v0.6.0 (sin etiquetar) | 2.1.306 (`validate`, `plugin test` y tests); el CI fija 2.1.305 | 24 | Fase de setup: `/arnes:setup` deja un proyecto listo desde su repo de carpeta, la composición lleva `remote` y `branch` por repo, init completa un manifiesto existente campo por campo, ship compara solo lo que entró al commit, el Stop no bloquea con trabajo en marcha y el panel separa la corrida de otra sesión |
| v0.6.1 (sin etiquetar) | 2.1.306 | 24 | Worktrees usables: `node_modules` enlazado y desenlazado antes de borrar, `.env` copiados con puertos por set, `--no-link` y `--port-offset` |
| v0.6.2 (sin etiquetar) | 2.1.306 | 24 | Menos vueltas por agente: review.js trae los nuevos sin trackear y el texto de las reglas, build.js arma la entrada del dev y del test-writer, el reviewer escribe su reporte, arnes-mod no llama a haiku para una pregunta evidente, sin test-runner, y los probadores instalan desde `probadores` |
| v0.6.3 (sin etiquetar) | 2.1.306 | 24 | La rama del issue nace al aprobar el plan, desde main fresco |
| v0.6.4 (sin etiquetar) | 2.1.306 | 24 | init con una sola ronda de preguntas y sin preguntar lo que sabe solo, afterBuild contra la base local, plan avisa si la rama va atrás, la ronda acotada cubre los archivos nuevos, la voz corta de las skills y dos correcciones de worktrees |
| v0.6.5 (sin etiquetar) | 2.1.306 | 24 | El arnés sobre los worktrees nativos de Claude Code en un repo solo (node_modules, puertos, rama del issue, pendientes sin subir), init con el grafo, la voz en SessionStart y el Stop, y verify contra el primer padre de un merge |
| v0.6.6 (sin etiquetar) | 2.1.306 | 24 | El reporte del reviewer lo guarda el hilo principal, y ExitWorktree en un worktree nativo manda a subir la rama |
| v0.6.7 (sin etiquetar) | 2.1.308 | 24 | El issue en un worktree nativo también en una carpeta, con la app levantada desde ahí; la lista de tareas para el escritorio; referencias, decisiones, prueba manual y mapa del grafo en el plan; ship que resuelve solo y habla como una persona; el registro por issue, su limpieza y su cierre en main |
| v0.6.8 (sin etiquetar) | 2.1.308 y 2.1.309 | 24 | El rescate de lo que queda sin commitear en los repos del worktree de una carpeta, con el marcador que hace preguntar a Claude Code antes de borrar y su recuperación en un worktree nuevo; la rama de un repo solo con el nombre del issue al aprobar |
| v0.6.9 (sin etiquetar) | 2.1.309 | 24 | Limpieza segura: el arnés para la app que levantó, desbloquea el worktree de una sesión que ya terminó, recupera la carpeta entera, recorta el plan por rutas, hace un fetch por repo cada dos minutos y junta limpiar en `/arnes:cerrar`; la ruta del worktree a la vista y el idioma de la persona; el `.env` negado se muestra enmascarado, y SessionStart anota la superficie |
| v0.7.0 (sin etiquetar) | 2.1.309 | 24 | Consolidación A: una llamada por transición, los mods leen la lógica del plugin base, arnes-ui sin sondeo ciego, resultados de tests como contrato estructurado y un solo sistema de worktrees; en la corrida A, de 83 llamadas a Bash a 37 y de US$4,60 a US$3,17 |
| v0.7.1 | 2.1.310 (`validate`, `plugin test` y tests; el CI fija 2.1.310) | 24 | Huecos cerrados antes del piloto: el Stop bloquea el código escrito sin plan aprobado también por el shell, la configuración del arnés solo cambia con init o setup, y el guard niega restore, checkout de rutas, checkout o switch forzados, stash drop o clear y el push que borra ramas del remoto |
| v0.7.2 (sin etiquetar) | 2.1.310 (`validate`, `plugin test` y tests) | 24 | init no pregunta: escribe todo en un turno, propone las riskPaths por el nombre de las rutas, adopta desde cero en la rama actual aunque otra rama remota traiga configuración, agrega su sección a un `CLAUDE.md` existente y dice en el cierre lo que decidió y lo que no pudo avanzar, con su comando |
| v0.7.3 (sin etiquetar) | 2.1.310 (`validate`, `plugin test` y tests) | 24 | Karma de serie para Angular (reporter propio que escribe cada test al terminar, configuración temporal con `--karma-config`, un `--include` por spec, línea base con el estado de la corrida: completa, abortada o no compila, y el gate de los specs tocados con un tsconfig temporal que solo los compila a ellos); init se cierra al final de su turno, las correcciones van por `/arnes:init --ajustar` y el Stop cierra el init o setup que siga abierto; `--check` dice lo mismo que init con la rama remota; la sección del `CLAUDE.md` se agrega siempre; el `remote` de una ruta de Windows |
| v0.7.4 (sin etiquetar) | 2.1.311 (`validate`, `plugin test` y tests) | 24 | Lo que init decide solo: el contrato por las carpetas, riskPaths por palabra completa y en categorías sin los falsos del español, lo prohibido de los scripts del `package.json`, la cuenta entera de una línea base que no compila y el JSON inválido como estado; el Stop no cierra init mientras corre la adopción, y sus pasos se ven en la timeline y en arnes-ui; plan consulta el grafo solo y planifica por caminos el reemplazo de un mensaje; cada agente corre con el modelo de su definición; la revisión se paga una vez, en ship |
| v0.7.5 (sin etiquetar) | 2.1.311 (`validate`, `plugin test` y tests) | 24 | Menos trabas: el lint de los tocados respeta el alcance del repo (`lintGlobs`), un «sí» de la persona a una propuesta de configuración abre la configuración ese turno, la coma de un `settings.json` la arregla el script, el plan aprobado no cierra sin construir y verify corrige en rojo sin pedir permiso, las preguntas llegan con los nodos del grafo, y el Stop dice el paso que sigue |
| v0.8.0 | 2.1.316 (`validate`, `plugin test` y tests) | 24 | Flujo liviano: carril corto con plan trivial aprobado por reglas y build en el hilo principal, plan por sesión (otra sesión planifica en su worktree), aviso del Stop una vez por estado, grafo solo con preguntas sobre el código, bandera que sobrevive al commit de otro workspace, verify que no repite lo verde y para a las tres vueltas en rojo, `.env` de cualquier worktree sin mostrarlo, spec renombrado que no es borrado, test-writer que revisa lo suyo y escribe las IT del plan, desviaciones del dev y defectos de lógica a la vista antes del push, y la convención que propone cada bloqueante de patrón |
| v0.8.1 | 2.1.316 (`validate`, `plugin test` y tests) | 24 | El lint tras cada edición con tope de 30 s, que mata el árbol de procesos al vencer y no reintenta en ese workspace por 10 minutos: un eslint type-checked tardaba tres minutos por archivo en renova365/api y colgaba cada edición hasta los 120 s del hook; init avisa «lint lento» al adoptar un repo así |
| v0.8.2 | 2.1.316 en el CI y 2.1.317 en local (`validate`, `plugin test` y tests) | 24 | Ruido y trabas: una sesión ajena no recibe el estado ni los avisos del Stop del trabajo de otra, ni escribe código bajo su plan; el grafo de una pregunta solo con un término de código y con los nodos que lo nombran; el Stop no pide construir con la rama a medias; un ajuste con el plan aprobado no lo reabre; una carpeta sin repo dice cómo hacerse repo de carpeta; la banda reinicia el gate al cambiar de worktree; el motivo de .ssh dice lo que protege; el test-writer corre las convenciones antes de entregar |

La última versión probada es la 2.1.316. Desde la 2.1.309, `claude` no se abre dentro de otra sesión de Claude Code: se niega si ve `CLAUDECODE` en el entorno ("Claude Code cannot be launched inside another Claude Code session"). Para correr `claude -p` desde una sesión, como en las pruebas de punta a punta, se lanza sin las variables que lo atan a ella (`CLAUDECODE`, el socket de mensajes y los ids de sesión), como si se abriera desde una terminal.
