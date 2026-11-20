---
name: cerrar
description: Cerrar y limpiar lo que el arnés creó para los issues. Cierra el issue cuyo MR ya se mergeó (la rama por defecto al día, la rama del issue borrada en local y en origin), recupera o descarta el trabajo sin commitear que quedó rescatado sin su worktree, y borra lo que sobre de los issues entregados (worktrees, ramas de tareas, informes, fotos y reportes), con su tamaño, solo lo que marque la persona, solo lo registrado y en orden seguro. Lo que ningún registro conoce solo se nombra.
argument-hint: "[<issue>]"
disable-model-invocation: true
---

# arnes:cerrar

Argumentos: `$ARGUMENTS` (opcional: el nombre corto de un issue, el que dice SessionStart, como `talleres`).

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el directorio de la sesión, cada comando solo. Quien lee no conoce el arnés (docs/PLAN.md §2): dile qué se cierra, qué se borra, dónde y cuánto ocupa, sin nombres de scripts ni códigos de salida.

El ciclo de un issue termina en main: planeado, construido, verificado, revisado, entregado, subido con su MR, mergeado y cerrado. El arnés anota en un registro por issue todo lo que crea para él, y esta skill cierra el ciclo y borra solo eso; antes de borrar, para la app que haya levantado. Nunca toca la conversación, ni nada que no esté en un registro.

Lo normal ya no pasa por aquí: al subir, ship borra lo que creó para el issue, y en cada entrega el arnés cierra solo los issues cuyo MR ya se mergeó. Esta skill es para no esperar a la próxima entrega y para lo que pide una decisión: un rescate, cambios sin commitear, algo entregado que no se mergeó, lo desconocido. Son dos comandos: uno mira y el otro hace.

1. **Mirar, sin borrar:** `node "S/issues.js" cerrar`, con el issue de `$ARGUMENTS` detrás si vino. Consulta los MR (con glab o gh) y dice, por cada issue entregado, subido o mergeado, o con un rescate:
   - con el MR mergeado, lo que haría al cerrarlo: la rama por defecto al día, la rama del issue borrada en local y en origin, y lo registrado que se borra, con su tamaño;
   - sin mergear, lo que se borraría, con su tamaño, y lo que se queda y por qué (un worktree con commits sin integrar, la rama del issue hasta el merge, cambios sin commitear, una sesión viva, un rescate de trabajo sin commitear que quedó sin su worktree);
   - al final, lo que hay en `.tmp` o en las carpetas de worktrees que ningún registro conoce.
2. **Con `$ARGUMENTS` y su MR mergeado, no preguntes:** la persona lo pidió al escribir la skill, y vas al paso 3 con ese issue. Si dice que la sesión está dentro del worktree del issue, sal con ExitWorktree y `action: "remove"`, y vuelve al paso 1. Si ExitWorktree no deja borrarlo porque la sesión no es su dueña, sal con `action: "keep"` y sigue: se borra desde el checkout principal.
   **Si no, una sola pregunta**, en un bloque numerado:
   - un punto por issue mergeado, con `Recomiendo:` cerrarlo;
   - un punto por issue entregado sin mergear, con lo que se borra y cuánto libera (la rama del issue se queda hasta el merge), y `Recomiendo:` borrarlo si está todo integrado;
   - cada rescate, en un punto aparte, con su repo y sus archivos, y `Recomiendo:` recuperarlo; descartarlo es la alternativa;
   - el worktree de una carpeta con un repo con cambios sin commitear, también aparte, con `Recomiendo:` dejarlo y commitear antes;
   - lo desconocido al final, solo nombrado, con su tamaño: "no las conozco; decide tú si se borran, a mano".

   Cierra con `Responde «sí a todo», o dime los números.` Termina el turno ahí.
3. **Hacer, con la respuesta:** `node "S/issues.js" cerrar --write` si fue «sí a todo», o `node "S/issues.js" cerrar <issue> <issue> --write` con los que marcó. Ese comando recupera los rescates, cierra lo mergeado y borra lo que sobra de lo demás; lo que no se puede borrar se queda, y dice por qué.
   - `--con-cambios` va solo con los issues en que la persona marcó descartar un rescate o perder cambios sin commitear, en un comando aparte del resto.
   - Si recuperó un rescate, di cómo seguir con la línea que imprime: en una carpeta vuelve el worktree de carpeta entero, y se sigue abriendo Claude Code en la carpeta con `--worktree <nombre>`.
   - Si algo no se pudo (por ejemplo, el checkout de la rama por defecto tiene cambios que chocan con lo que trae origin), di qué tiene que hacer la persona, y que vuelva a escribir `/arnes:cerrar <issue>`.
   - Si dice que falta el worktree de esta sesión, sal de él con ExitWorktree y `action: "remove"`: el arnés para la app, y quita primero sus enlaces y sus repos. Si ExitWorktree se niega porque la sesión no es su dueña, sal con `action: "keep"` y vuelve a correr el cierre, que ya puede borrarlo desde afuera. Nunca borres a mano una carpeta del registro ni una desconocida.

Lo que lee la persona: una línea por issue con lo que se cerró, lo que se recuperó y dónde, lo que se borró y lo que se liberó, lo que se quedó y por qué, y lo desconocido que sigue ahí. El detalle de cada comando va al informe: `node "S/informe.js" path cerrar` da la ruta, y el chat la dice en una línea.
