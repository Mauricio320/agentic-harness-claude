---
name: plan
description: Implementar, corregir o agregar algo a partir de un issue (número, URL o texto). Es la primera acción de todo pedido que cambie código. Antes de tocar código escribe .tmp/harness/plan.md con criterios de aceptación, contrato de API, tablas y migraciones, zonas de riesgo y preguntas cerradas, y pide confirmación.
argument-hint: "[--trivial] <número o URL del issue, o el texto del pedido>"
---

# arnes:plan

Pedido: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio de la sesión. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. El plan lo aprueba alguien que no conoce el stack: frases cortas, cada término técnico explicado en pocas palabras la primera vez, sin bloques de código. Sin plan aprobado, el guard niega escribir código.

**Con `--trivial`**, y solo si lo escribió la persona: corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-state.js" trivial --pedido "<el pedido>" --criterio "<un criterio que se pueda comprobar>"`, di en una línea que quedó un plan mínimo aprobado y sigue con el cambio. Escribe el plan mínimo y lo deja aprobado. Si sale con 1, di el motivo y sigue con el plan completo. Nunca agregues `--trivial` por tu cuenta.

1. Anota el inicio: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start plan --detail "<el issue en pocas palabras>"`.
2. Proyecto: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show` da la raíz y los workspaces. Lee `.claude/harness.json` del workspace que vas a tocar: sus `riskPaths` y su `contract`. Si sale con 2, no hay manifiesto: sigue y dilo en el plan.
   - **¿La rama va atrás?** `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-branch.js" behind` hace fetch y dice, en una línea por repo, cuántos commits va atrás de origin. Si dice alguna, dila en una línea al inicio del mensaje del plan, con el número de commits, y ofrece `/arnes:sync` antes de construir. Nunca hagas pull por tu cuenta.
3. El issue:
   - Número o URL: con `glab issue view <n> --comments` si el remote es GitLab, o `gh issue view <n> --comments` si es GitHub, siempre que el CLI exista. Si no existe o falla, pide el texto a la persona. Nunca lo inventes.
   - Texto: úsalo textual. Es la fuente de los criterios literales.
4. El código, lo mínimo para decidir:
   - Lee el `CLAUDE.md` y las `.claude/rules/*.md` del workspace: el plan sigue sus convenciones.
   - Si el repo tiene `graphify-out/graph.json` y `graphify --help` responde, pregunta al grafo antes de abrir archivos: `graphify query "<pregunta>"`, `graphify explain "<concepto>"`, `graphify path "<A>" "<B>"`. Abre solo las líneas que el grafo ubicó.
   - Sin graphify: Grep por los nombres del issue (modelo, tabla, ruta, rol) y abre un módulo parecido como referencia. No barras el repo.
   - Confirma en el código lo que el issue da por hecho (que un modelo existe, cómo se nombran sus columnas, cómo se controla el acceso por rol). Lo que no encuentres va a Preguntas.
5. Escribe `.tmp/harness/plan.md` en la raíz del proyecto, con estas secciones en este orden:
   - `# Plan: <título corto>`. Esta primera línea la muestra arnes-ui.
   - `Issue:` la referencia, y una línea con lo que se pide.
   - `## Criterios de aceptación`: numerados C1, C2…, cada uno como comportamiento que se puede comprobar ("un coordinador crea un taller y lo ve en la lista"). Marca cada uno `[literal]` si está en el issue, o `[inferido]` si lo deduces tú, con el porqué en la misma línea.
   - `## Contrato de API`: por endpoint, método y ruta, request (campos, tipo, obligatorio), response (forma y códigos de error) y roles que pueden llamarlo. Si no hay API, dilo.
   - `## Datos`: tablas y columnas que se leen o se escriben. Por cada migración nueva, qué cambia y si tiene vuelta atrás. Si no hace falta ninguna, escribe `sin migración`.
   - `## Workspaces y orden`: qué parte va en cada workspace. El back va antes que el front, y el contrato del back es lo que el front consume.
   - `## Archivos previstos`: los archivos que se crean o se modifican, por workspace.
   - `## Zonas de riesgo`: coteja cada archivo previsto con los globs de `riskPaths` de su workspace y lista los que caen, con el glob. Si cae alguno, escribe `REVISIÓN HUMANA OBLIGATORIA`. Si el workspace no declara `riskPaths`, dilo, y marca igual lo que toque migraciones, autenticación o permisos.
   - `## Preguntas`: solo cerradas (sí o no, o elegir una opción). Cada una lleva `Recomendación:` con su motivo, y `Alternativa:` real, con lo que cuesta o lo que cambia. Nada de preguntas abiertas.
   - `## Fuera de alcance`: lo que el issue no pide y no se hace.
6. Con el plan escrito, cierra la etapa: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" end plan --result ok --detail "plan escrito"`. Desde aquí el tiempo es de la persona, no del plan: el Stop anota que el turno cerró, y su respuesta cierra la espera.
7. Dónde se construye: corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-branch.js" check`.
   - **Si dice `worktree: <nombre>`** (lo normal): al aprobar, esta sesión se mueve a un worktree nuevo con ese nombre, desde main al día, y los checkouts de la persona no se tocan. Va en el mensaje de aprobación como lo que vas a hacer, con su línea `al aprobar:` en palabras simples y la `alternativa:` (la rama en el checkout), que la persona elige si la pide.
   - **En un worktree nativo de Claude Code** (ya estás en uno): la rama del issue es la del worktree. No preguntes nada ni crees otra.
   - **Si dice `en el checkout:`** (la configuración lo pide, o no se puede abrir un worktree): todos en la rama por defecto, no preguntes; alguno en otra rama, agrega a `## Preguntas` la pregunta que imprimió, tal cual, con su recomendación y su alternativa.
8. Pide confirmación explícita en un solo mensaje (docs/PLAN.md §2): una línea con la ruta del plan y si toca zonas de riesgo, los criterios en una lista corta, y las preguntas en un bloque numerado, cada una con su recomendación y su alternativa, contestable con "sí a todo". Sin nombres de scripts ni salidas de comandos. Termina el turno ahí, sin la herramienta de preguntas: la aprobación vale solo si llega en un mensaje de la persona. No edites código ni lances agentes antes de esa respuesta.
9. Con la respuesta:
   - **Si aprueba:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/plan-state.js" approve`. Si sale con 1, di el motivo y espera. Pasa las preguntas respondidas a `## Decisiones`, con lo elegido, ajusta los criterios y escribe `Aprobado: <fecha> por la persona` bajo el título.
   - **El worktree, antes de construir:** si check dijo `worktree: <nombre>` y la persona no pidió la alternativa, llama a la herramienta EnterWorktree con `name: "<nombre>"` (o con `path`, si check dijo que ya existe). La sesión queda en el worktree; desde ahí corre `issue-branch.js create`, que trae el plan aprobado, en una carpeta trae cada repo del plan en la rama del issue, y la anota. Si EnterWorktree no está o falla, dilo y sigue con la alternativa.
   - **La rama en el checkout** (la alternativa, o `en el checkout:`): en la rama por defecto, `issue-branch.js create`; en otra rama, con el sí a la recomendación, `create --desde-otra`, y con la alternativa, `issue-branch.js stay`. Si sale con 1, di el motivo y espera: con cambios sin commitear en otra rama, la persona los commitea o los guarda antes.
   - No escribas la línea `Rama:` a mano: la escribe create. Di en una línea dónde quedó, y anota la elección en `## Decisiones`.
   - Con la rama lista, si aprobó construir, sigue con la skill build.
   - **Si pide cambios:** `timeline.js start plan --detail "ajuste"`, ajusta el plan y vuelve al paso 6.
   - **Si lo descarta:** `timeline.js note plan --result cancelado`.

Si `.tmp/harness/plan.md` ya existe y es de otro issue, pregunta antes de pisarlo. Una decisión de arquitectura que salga del plan se guarda después con la skill memory, no aquí.
