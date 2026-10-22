---
name: cerrar
description: Cerrar un issue cuyo MR ya se mergeó (o que se mergeó en local): trae la rama por defecto de cada repo al día con fast-forward, borra la rama del issue local y remota, borra lo que el arnés creó para él y lo marca cerrado.
argument-hint: "<issue>"
disable-model-invocation: true
---

# arnes:cerrar

Argumentos: `$ARGUMENTS`, el nombre corto del issue (el que dice SessionStart, como `talleres`).

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el checkout principal, cada comando solo. Quien lee no conoce el arnés (docs/PLAN.md §2): sin nombres de scripts ni códigos de salida.

El ciclo de un issue termina en main: planeado, construido, verificado, revisado, entregado, subido con su MR, mergeado y cerrado. Cerrar es el último paso, y lo pide la persona escribiendo esta skill.

1. `node "S/issues.js" close <issue>`: dice si el MR está mergeado (lo consulta con glab o gh) y qué hará: la rama por defecto al día, la rama del issue que se borra en local y en origin, y lo registrado que se borra, con su tamaño.
   - **Si dice que no está mergeado**, o que no tiene MR: dilo en una línea y termina. No cierres nada.
   - **Si dice que la sesión está dentro del worktree del issue**: sal con ExitWorktree y `action: "remove"`, y vuelve a correr este paso.
2. Con el MR mergeado, `node "S/issues.js" close <issue> --write`. La persona lo pidió al escribir la skill: no vuelvas a preguntar.
3. Si algo no se pudo (por ejemplo, el checkout de la rama por defecto tiene cambios que chocan con lo que trae origin), dilo con lo que tiene que hacer la persona, y que vuelva a escribir `/arnes:cerrar <issue>`.

Lo que lee la persona: una línea con lo que quedó (la rama por defecto al día, la rama del issue borrada, cuánto se liberó) o lo que falta. El detalle va al informe: `node "S/informe.js" path cerrar` da la ruta, y el chat la dice en una línea.
