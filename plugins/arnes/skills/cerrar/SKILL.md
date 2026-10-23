---
name: cerrar
description: Cerrar y limpiar lo que el arnés creó para los issues. Cierra el issue cuyo MR ya se mergeó (la rama por defecto al día, la rama del issue borrada en local y en origin), recupera o descarta el trabajo sin commitear que quedó rescatado sin su worktree, y borra lo que sobre de los issues entregados (worktrees, ramas de tareas, informes, fotos y reportes), con su tamaño, solo lo que marque la persona, solo lo registrado y en orden seguro. Lo que ningún registro conoce solo se nombra.
argument-hint: "[<issue>]"
disable-model-invocation: true
---

# arnes:cerrar

Argumentos: `$ARGUMENTS` (opcional: el nombre corto de un issue, el que dice SessionStart, como `talleres`).

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el directorio de la sesión, cada comando solo. Quien lee no conoce el arnés (docs/PLAN.md §2): dile qué se cierra, qué se borra, dónde y cuánto ocupa, sin nombres de scripts ni códigos de salida.

El ciclo de un issue termina en main: planeado, construido, verificado, revisado, entregado, subido con su MR, mergeado y cerrado. El arnés anota en un registro por issue todo lo que crea para él: los worktrees y sus ramas, el worktree de la sesión, la rama del issue, el plan, los informes, las fotos de typecheck, los reportes de review y la app que levantó. Esta skill cierra el ciclo y borra solo eso; antes de borrar, el arnés para la app que haya levantado. Nunca toca la conversación, ni nada que no esté en un registro.

1. **Mirar, sin borrar:**
   - `node "S/issues.js" list`: cada issue con su estado, lo que sigue en disco y sus rescates.
   - Por cada issue subido o mergeado, o el de `$ARGUMENTS`: `node "S/issues.js" close <slug>`. Dice si el MR está mergeado (lo consulta con glab o gh) y qué haría al cerrarlo: la rama por defecto al día, la rama del issue borrada en local y en origin, y lo registrado que se borra, con su tamaño.
   - Por cada issue entregado que no se puede cerrar todavía, y por cada uno que `list` muestre con un rescate, esté en el estado que esté: `node "S/issues.js" clean <slug>`. Dice qué se borraría, con su tamaño, y qué se queda y por qué (un worktree con commits sin integrar, una rama del issue cuyo MR no está mergeado, un worktree con cambios sin commitear o bloqueado por una sesión viva, un rescate de trabajo sin commitear que quedó sin su worktree).
   - `node "S/issues.js" unknown`: lo que hay en `.tmp` o en las carpetas de worktrees que ningún registro conoce.
2. **Con `$ARGUMENTS` y su MR mergeado, no preguntes:** la persona lo pidió al escribir la skill, y vas al paso 3 con ese cierre. Si la sesión está dentro del worktree del issue, sal con ExitWorktree y `action: "remove"`, y vuelve a correr `close`.
   **Si no, una sola pregunta**, en un bloque numerado:
   - un punto por issue mergeado, con `Recomiendo:` cerrarlo;
   - un punto por issue entregado sin mergear, con lo que se borra y cuánto libera (la rama del issue se queda hasta el merge), y `Recomiendo:` borrarlo si está todo integrado;
   - cada rescate de trabajo sin commitear que quedó sin su worktree, en un punto aparte, con su repo y sus archivos, y `Recomiendo:` recuperarlo; descartarlo es la alternativa;
   - el worktree de una carpeta con un repo con cambios sin commitear, también aparte, con `Recomiendo:` dejarlo y commitear antes;
   - lo desconocido al final, solo nombrado, con su tamaño: "no las conozco; decide tú si se borran, a mano".

   Cierra con `Responde «sí a todo», o dime los números.` Termina el turno ahí.
3. **Con la respuesta**, en este orden y por cada punto marcado:
   - **Recuperar:** `node "S/issues.js" recover <slug>`, y di cómo seguir con la línea que imprime: en una carpeta vuelve el worktree de carpeta entero, con sus repos adentro, y se sigue abriendo Claude Code en la carpeta con `--worktree <nombre>`.
   - **Cerrar:** `node "S/issues.js" close <slug> --write`. Si algo no se pudo (por ejemplo, el checkout de la rama por defecto tiene cambios que chocan con lo que trae origin), di qué tiene que hacer la persona, y que vuelva a escribir `/arnes:cerrar <issue>`.
   - **Borrar:** `node "S/issues.js" clean <slug> --write`, con `--con-cambios` solo si la persona marcó perder esos cambios.

   Si dice que falta el worktree de esta sesión, sal de él con la herramienta ExitWorktree y `action: "remove"`: el arnés para la app, y quita primero sus enlaces y sus repos. Nunca borres a mano una carpeta del registro ni una desconocida.

Lo que lee la persona: una línea por issue con lo que se cerró, lo que se recuperó y dónde, lo que se borró y lo que se liberó, lo que se quedó y por qué, y lo desconocido que sigue ahí. El detalle de cada comando va al informe: `node "S/informe.js" path cerrar` da la ruta, y el chat la dice en una línea.
