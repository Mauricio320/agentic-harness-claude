---
name: init
description: Genera y valida los manifiestos .claude/harness.json de un proyecto, uno por repo y la composición de la carpeta si es multi-repo; con --check comprueba el mínimo de adopción.
argument-hint: "[--check]"
disable-model-invocation: true
---

# arnes:init

Argumentos: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el directorio de la sesión, cada comando solo. Quien lee no conoce el arnés: no le nombres scripts, flags ni códigos de salida. Dile qué vas a escribir, en qué archivo y para qué, en frases cortas.

## Con --check

Corre `node "S/adoption-check.js"`. Di en una línea cuántas comprobaciones pasan y, por cada FALTA, qué hay que hacer para cerrarla. MANUAL (configuración del host git) y NO ADOPTABLE (un repo sin manifiesto propio, como uno PHP) no son faltas. No modifiques nada.

## Sin argumentos

Anota el inicio, `node "S/lib/timeline.js" start init`, y al cerrar `end init --result ok`: mientras init está en curso, las respuestas de la persona no se toman como pedidos de código.

### 1. Mirar, sin escribir ni preguntar

- `node "S/init-draft.js"`: los manifiestos que faltan, con lo que detectó de cada repo (comandos, specs, lo prohibido, el contract y la rama de cada repo en la composición). De los que ya existen dice que no se tocan.
- **Si dice que una rama remota trae el manifiesto que falta**, detente: di "<repo> está en <rama>, que no trae la configuración del arnés; <rama remota> sí la trae. Cámbiate a esa rama y vuelve a correr /arnes:init." No propongas nada desde cero.
- Si algún manifiesto ya existe: `node "S/adopt.js" complete`, lo que le falta a cada uno.
- `node "S/adopt.js" probe`, `hooks`, `permissions`, `claude-md`, `folder-settings` (solo en una carpeta multi-repo) y `baseline <ws>` por workspace: qué haría cada paso, sin hacerlo.

### 2. Lo que se escribe sin preguntar

- `node "S/init-draft.js" --gitignore`: agrega al `.gitignore` de la carpeta las carpetas de los repos, `.tmp/`, `.claude/settings.local.json` y `graphify-out/`. Dilo en una línea con lo que agregó.
- No preguntes lo que puedes saber solo: los nombres de cada workspace (los del repo), la rama de cada repo en la composición (la calcula el script), la dirección y la rama del marketplace (salen del plugin instalado), ni el contract y la integración que el borrador ya propone.

### 3. Una sola ronda de preguntas

Un solo mensaje, con un bloque numerado. Cada punto dice qué se escribe y dónde, con `Recomiendo:` y el porqué en una frase. Entra todo lo que el paso 1 encontró, también lo que falta a un manifiesto existente:
- **La configuración de cada repo nuevo** (`<repo>/.claude/harness.json`): sus comandos, y las rutas que exigen revisión humana (`riskPaths`). Propón las que ves en el código, como migraciones, autenticación o permisos, y di de dónde salen.
- **La composición de la carpeta**: los repos, la rama de cada uno, qué provee y qué consume cada uno, y la misma rama del issue en todos con `feature/`.
- **Lo que le falta a una configuración existente**, un punto por campo: las convenciones (comentarios, `any`, `console.`, TODO), los comandos que tocan una base o reescriben archivos, que se le prohíben al modelo, y el contract.
- **La sincronización después del build** (`afterBuild`), si el repo tiene scripts de sync: el build y la sincronización corren solos al cerrar cada build, solo si el `.env` apunta a la base local. Muestra el patrón de base local y pide confirmarlo.
- **Los hooks del arnés anterior** a quitar, **los permisos** para que no pregunte por cada comando (van a `.claude/settings.local.json`, que no se commitea), **el CLAUDE.md de la carpeta**, **el settings.json de la carpeta** con el marketplace y **la línea base de tests** de cada repo con el árbol limpio.
- **Un flag que le falta al comando de test** si probe lo dice.

Cierra el bloque con: `Responde «sí a todo», o dime los números que cambias.` Termina el turno ahí.

### 4. Con la respuesta

Aplica lo aceptado, sin volver a preguntar:
- `node "S/init-draft.js" --write` escribe los manifiestos que faltan y no toca los existentes. Pisar uno existente es `--force <ruta>`, solo si la persona lo pidió para ese archivo. Las correcciones que dictó, con Edit.
- `node "S/adopt.js" complete --only <campo> --write` por cada campo aceptado; `hooks --remove`; `permissions --write`; `claude-md --write`; `folder-settings --write`; `baseline <ws> --write`.
- Valida con `node "S/lib/manifest.js" show`. Si no valida, corrígelo antes de seguir.
- Si un paso no corre porque falta una dependencia, dilo con el comando: instalarla es de la persona. init no instala ni commitea.

### 5. El cierre

Una línea con lo que quedó escrito y una lista corta de lo que le toca a la persona:
- commitear la configuración de cada repo en ese repo, y la línea base con `gates:` al inicio del asunto;
- si la carpeta no es un repo, `git init` y subirla: con eso otra persona la prepara con `/arnes:setup <url>`.

Termina con: "Para trabajar, escribe tu pedido en lenguaje normal; el arnés planifica, construye, verifica y revisa solo, y al final pides /arnes:ship." Nunca sugieras invocar plan, build, verify ni review a mano.

Un repo con solo `composer.json` (PHP), o sin typecheck ni test detectables, entra en la composición sin manifiesto propio, y eso no es un error.
