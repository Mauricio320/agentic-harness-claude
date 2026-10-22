---
name: init
description: Genera y valida los manifiestos .claude/harness.json de un proyecto, uno por repo y la composición de la carpeta si es multi-repo; con --check comprueba el mínimo de adopción.
argument-hint: "[--check | --baseline]"
disable-model-invocation: true
---

# arnes:init

Argumentos: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el directorio de la sesión, cada comando solo. Quien lee no conoce el arnés (docs/PLAN.md §2): no le nombres scripts, flags ni códigos de salida. Dile qué vas a escribir, en qué archivo y para qué, en frases cortas.

## Con --check

Corre `node "S/adoption-check.js"`. Di en una línea cuántas comprobaciones pasan y, por cada FALTA, qué hay que hacer para cerrarla. MANUAL (configuración del host git) y NO ADOPTABLE (un repo sin manifiesto propio, como uno PHP) no son faltas. No modifiques nada.

## Con --baseline

Solo el paso de la línea base, para cuando init no la pudo tomar porque el árbol tenía cambios: anota `start init --detail "línea base"`, corre `node "S/adopt.js" baseline <ws> --write` por cada workspace adoptable y di en una línea qué quedó. Si alguno sigue con cambios, di qué archivos estorban. Cierra con `end init --result ok` y lo que hay que commitear (con `gates:` al inicio del asunto).

## Sin argumentos

Anota el inicio, `node "S/lib/timeline.js" start init`, y al cerrar `end init --result ok`: mientras init está en curso, las respuestas de la persona no se toman como pedidos de código.

### 1. Mirar, sin escribir ni preguntar

- `node "S/init-draft.js"`: los manifiestos que faltan, con lo que detectó de cada repo (comandos, specs, lo prohibido, el contract y la rama de cada repo en la composición). De los que ya existen dice que no se tocan.
- **Si imprime `pregunta`** porque una rama remota trae la configuración que a un repo le falta, no te detengas: va a la ronda como un punto más, con su recomendación (cambiarse a esa rama) y su alternativa (adoptar desde cero aquí).
- Si algún manifiesto ya existe: `node "S/adopt.js" complete`, lo que le falta a cada uno.
- `node "S/adopt.js" probe`, `hooks`, `baseref`, `permissions`, `worktreeinclude`, `claude-md`, `folder-settings` (solo en una carpeta multi-repo), `baseline <ws>` por workspace y `graph`: qué haría cada paso, sin hacerlo.

### 2. Lo que se escribe sin preguntar

- `node "S/init-draft.js" --gitignore`: agrega al `.gitignore` de la carpeta las carpetas de los repos, `.tmp/`, `.claude/settings.local.json` y `graphify-out/`. Dilo en una línea con lo que agregó.
- No preguntes lo que puedes saber solo: los nombres de cada workspace (los del repo), la rama de cada repo en la composición (la calcula el script), la dirección y la rama del marketplace (salen del plugin instalado), ni el contract y la integración que el borrador ya propone.

### 3. Una sola ronda de preguntas

Un solo mensaje, con un bloque numerado. Cada punto dice qué se escribe y dónde, con `Recomiendo:` y el porqué en una frase. Entra todo lo que el paso 1 encontró, también lo que falta a un manifiesto existente:
- **La configuración de cada repo nuevo** (`<repo>/.claude/harness.json`): sus comandos, y las rutas que exigen revisión humana (`riskPaths`). Propón las que ves en el código, como migraciones, autenticación o permisos, y di de dónde salen.
- **La composición de la carpeta**: los repos, la rama de cada uno, qué provee y qué consume cada uno, y la misma rama del issue en todos con `feature/`.
- **Lo que le falta a una configuración existente**, un punto por campo: las convenciones (comentarios, `any`, `console.`, TODO), los comandos que tocan una base o reescriben archivos, que se le prohíben al modelo, y el contract.
- **La sincronización después del build** (`afterBuild`), si el repo tiene scripts de sync: el build y la sincronización corren solos al cerrar cada build, solo si el `.env` apunta a la base local. Di el patrón de base local en palabras (host y puerto) y pide confirmarlo.
- **Los hooks del arnés anterior** a quitar, **los permisos** para que no pregunte por cada comando (van a `.claude/settings.local.json`, que no se commitea), **el CLAUDE.md de la carpeta**, **el settings.json de la carpeta** con el marketplace, **la línea base de tests** de cada repo con el árbol limpio y, si graphify está instalado, **el grafo de código** de cada repo, que va después de la línea base. Sin graphify, una línea con cómo instalarlo, `uv tool install graphify`, y sigue sin él.
- **El .worktreeinclude** de cada repo con `.env`, para que los worktrees que crea Claude Code (`claude --worktree`, el escritorio) nazcan con sus `.env`; se commitea en el repo.
- **Quitar `worktree.baseRef: "head"`** de un `.claude/settings.json` versionado, si lo tiene: un worktree de Claude Code tiene que nacer de origin, no del HEAD de quien lo abre.
- **Un flag que le falta al comando de test**, si probe lo dice: qué se agrega y para qué ("para que el arnés lea cada test"). Nunca se aplica sin esta ronda.
- **La línea `graphify-out/` en el `.gitignore` de cada repo** que no la tiene, si el paso del grafo la ofrece: el grafo nunca es código del issue.

Cierra el bloque con: `Responde «sí a todo», o dime los números que cambias.` Termina el turno ahí.

### 4. Con la respuesta

Aplica lo aceptado, sin volver a preguntar:
- `node "S/init-draft.js" --write` escribe los manifiestos que faltan y no toca los existentes. Pisar uno existente es `--force <ruta>`, solo si la persona lo pidió para ese archivo. Las correcciones que dictó, con Edit.
- La rama remota con la configuración: con el sí a cambiarse, `node "S/adopt.js" switch <repo> --to <rama remota> --write` y vuelve a mirar ese repo; con la alternativa, `init-draft.js --write --force <repo>/.claude/harness.json`.
- El flag del comando de test, si se aceptó: `node "S/adopt.js" probe --ws <ws> --write`.
- `node "S/adopt.js" complete --only <campo> --write` por cada campo aceptado; `hooks --remove`; `baseref --remove`; `permissions --write`; `worktreeinclude --write`; `claude-md --write`; `folder-settings --write`; `baseline <ws> --write`; después de la línea base, `graph --write`, y di cuánto tardó.
- Valida con `node "S/lib/manifest.js" show`. Si no valida, corrígelo antes de seguir.
- Si un paso no corre porque falta una dependencia, dilo con el comando: instalarla es de la persona. init no instala ni commitea.
- **Si la línea base no se pudo tomar** por cambios sin commitear, di qué archivos estorban y que, cuando los commitee o los guarde, `/arnes:init --baseline` corre solo ese paso, sin repetir todo.

### 5. El cierre

El detalle (cada archivo escrito, las salidas de los pasos) va al informe: `node "S/informe.js" path init` da la ruta; escríbelo ahí con Write. En el chat, una línea con lo que quedó escrito y la ruta del informe, y una lista corta de lo que le toca a la persona:
- commitear la configuración de cada repo en ese repo, y la línea base con `gates:` al inicio del asunto;
- si la carpeta no es un repo, `git init` y subirla: con eso otra persona la prepara con `/arnes:setup <url>`.

Termina con: "Para trabajar, escribe tu pedido en lenguaje normal; el arnés planifica, construye, verifica y revisa solo, y al final pides /arnes:ship." Nunca sugieras invocar plan, build, verify ni review a mano. Si informe.js dijo `frase: dila`, cierra con "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio."

Un repo con solo `composer.json` (PHP), o sin typecheck ni test detectables, entra en la composición sin manifiesto propio, y eso no es un error.
