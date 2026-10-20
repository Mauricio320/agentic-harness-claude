---
name: plan
description: Implementar, corregir o agregar algo a partir de un issue (número, URL o texto). Antes de tocar código escribe .tmp/harness/plan.md con criterios de aceptación, contrato de API, tablas y migraciones, zonas de riesgo y preguntas cerradas, y pide confirmación.
argument-hint: "<número o URL del issue, o el texto del pedido>"
---

# arnes:plan

Pedido: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio de la sesión. El plan lo aprueba alguien que no conoce el stack: frases cortas, cada término técnico explicado en pocas palabras la primera vez, sin bloques de código.

1. Anota el inicio: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start plan --detail "<el issue en pocas palabras>"`.
2. Proyecto: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show` da la raíz y los workspaces. Lee `.claude/harness.json` del workspace que vas a tocar: sus `riskPaths` y su `contract`. Si sale con 2, no hay manifiesto: sigue y dilo en el plan.
3. El issue:
   - Número o URL: con `glab issue view <n> --comments` si el remote es GitLab, o `gh issue view <n> --comments` si es GitHub, siempre que el CLI exista. Si no existe o falla, pide el texto a la persona. Nunca lo inventes.
   - Texto: úsalo tal cual. Es la fuente de los criterios literales.
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
6. Muestra el plan completo y pide confirmación explícita: que lo apruebe y responda las preguntas. No edites código ni lances agentes antes de esa respuesta.
7. Con la respuesta:
   - Pasa las preguntas respondidas a `## Decisiones`, con lo elegido.
   - Ajusta los criterios.
   - Escribe `Aprobado: <fecha> por la persona` bajo el título.
   - Anota el fin: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" end plan --result ok`, o `--result cancelado` si la persona lo descarta.
   - Si la persona aprobó construir, sigue con la skill build.

Si `.tmp/harness/plan.md` ya existe y es de otro issue, pregunta antes de pisarlo. Una decisión de arquitectura que salga del plan se guarda después con la skill memory, no aquí.
