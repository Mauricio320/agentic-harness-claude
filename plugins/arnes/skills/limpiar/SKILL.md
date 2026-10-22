---
name: limpiar
description: Limpiar lo que el arnés creó para los issues ya entregados (worktrees, ramas de tareas, informes, fotos y reportes), con su tamaño, borrando solo lo que marque la persona, solo lo registrado y en orden seguro. Lo que ningún registro conoce solo se nombra.
argument-hint: "[<slug>]"
disable-model-invocation: true
---

# arnes:limpiar

Argumentos: `$ARGUMENTS` (opcional: el issue a limpiar).

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el directorio de la sesión, cada comando solo. Quien lee no conoce el arnés (docs/PLAN.md §2): dile qué se borra, dónde y cuánto ocupa, sin nombres de scripts ni códigos de salida.

El arnés anota en un registro por issue todo lo que crea para él: los worktrees y sus ramas, el worktree de la sesión, la rama del issue, el plan, los informes, las fotos de typecheck y los reportes de review. Esta skill borra solo eso. Nunca toca la conversación, ni nada que no esté en un registro.

1. **Mirar, sin borrar:**
   - `node "S/issues.js" list`: cada issue con su estado y lo que sigue en disco.
   - Por cada issue entregado (o el de `$ARGUMENTS`), `node "S/issues.js" clean <slug>`: qué se borraría, con su tamaño, y qué se queda y por qué (un worktree con commits sin integrar, una rama del issue cuyo MR no está mergeado, un worktree con cambios sin commitear).
   - `node "S/issues.js" unknown`: lo que hay en `.tmp` o en las carpetas de worktrees que ningún registro conoce.
2. **Una sola pregunta**, en un bloque numerado: un punto por issue, con lo que se borra y cuánto libera, y `Recomiendo:` borrar los issues entregados con todo integrado. Lo desconocido va al final, solo nombrado, con su tamaño: "no las conozco; decide tú si se borran, a mano". Cierra con `Responde «sí a todo», o dime los números que borro.` Termina el turno ahí.
3. **Con la respuesta:** por cada issue marcado, `node "S/issues.js" clean <slug> --write`. Si dice que falta el worktree de esta sesión, sal de él con la herramienta ExitWorktree y `action: "remove"`: el arnés quita primero sus enlaces y sus repos. Nunca borres a mano una carpeta del registro ni una desconocida.

Lo que lee la persona: una línea por issue con lo que se borró y lo que se liberó, lo que se quedó y por qué, y lo desconocido que sigue ahí. El detalle de cada comando va al informe: `node "S/informe.js" path limpiar` da la ruta, y el chat la dice en una línea.
