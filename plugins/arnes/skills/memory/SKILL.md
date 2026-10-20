---
name: memory
description: Guardar o recordar la memoria del proyecto. decision escribe una decisión de arquitectura en docs/decisions, gotcha agrega una trampa conocida a docs/gotchas.md, y recall busca lo ya decidido (y en graphify si existe) antes de decidir algo parecido.
argument-hint: "decision <título> | gotcha <texto> | recall <tema>"
---

# arnes:memory

Argumentos: `$ARGUMENTS`

La memoria es markdown versionado en el repo, visible para el equipo y para los MR. No usa ningún MCP.

Anota `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start memory --detail "<modo>"` al empezar, y `end memory --result ok` al terminar, con la ruta entre comillas.

## Dónde

- Va en el repo del workspace al que se refiere. Si cruza repos, va en el que provee el contrato, con una línea en el otro que apunte al archivo.
- Las rutas salen del `memory` del `.claude/harness.json` de ese repo: `notes` (por defecto `docs/decisions`) y `gotchas` (por defecto `docs/gotchas.md`).
- Si `git check-ignore -q <ruta>` dice que la ruta está ignorada, avísalo: el archivo no se versionaría.

## decision <título>

1. Reúne de la conversación tres cosas: qué se decidió, por qué, y qué alternativa se descartó y por qué. Si falta el porqué o la alternativa, pregúntalo en un solo mensaje. No lo inventes.
2. El archivo es `<notes>/AAAA-MM-DD-<slug>.md`, con la fecha de hoy y un slug en kebab-case de seis palabras como máximo. Si ya existe uno con ese nombre, no lo pises: agrega `-2`.
3. Contenido:
   ```
   # <Título en una línea>

   Fecha: AAAA-MM-DD · Workspace: <ws> · Issue: <ref, o "sin issue">

   ## Qué
   <la decisión, en dos a cinco líneas>

   ## Por qué
   <el motivo, con el dato o el incidente que lo sostiene>

   ## Alternativa descartada
   <cuál, y por qué no>
   ```
4. SessionStart muestra el título de las cinco decisiones más recientes, así que el título tiene que entenderse solo.

## gotcha <texto>

Agrega una línea al final de `<gotchas>`. Si el archivo no existe, créalo con el título `# Gotchas`. La línea va así: `- AAAA-MM-DD · <ws> · <síntoma> → <causa> → <qué hacer>`. Antes de agregarla, busca con Grep si ya existe una parecida; si existe, actualízala en vez de duplicarla.

## recall <tema>

1. Busca con Grep, sin distinguir mayúsculas, las palabras del tema en `<notes>/` y en `<gotchas>` de cada repo del proyecto. Lee las decisiones que coincidan.
2. Si el repo tiene `graphify-out/graph.json` y `graphify --help` responde, corre `graphify query "<tema>"`, que también indexa los docs.
3. Responde citando cada archivo con su fecha. Si no hay nada, dilo. recall no escribe nada.

No commitees. Di la ruta del archivo escrito: se versiona con el próximo commit del repo.
