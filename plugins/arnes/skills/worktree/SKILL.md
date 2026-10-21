---
name: worktree
description: Abrir, integrar o cerrar los worktrees de las tareas de un issue, en ramas wt/<rama-issue>/<slug> registradas en .tmp/harness/worktrees.json. Integrar es git merge --no-ff en la rama del issue, nunca squash.
argument-hint: "open <slug> [--ws <workspace>]... [--issue <ref>] [--no-link] [--port-offset N] | integrate <slug> | close <slug> | list | pending"
disable-model-invocation: true
---

# arnes:worktree

Argumentos: `$ARGUMENTS`

Todo pasa por `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree-ledger.js" <subcomando>`, con la ruta entre comillas y desde el directorio de la sesión. El script resuelve el registro del checkout principal aunque lo corras desde un worktree. No uses `git worktree` ni `git branch -D` a mano: el registro quedaría desfasado.

Antes de nada, anota `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start worktree --detail "<subcomando> <slug>"`. Al terminar, anota `end worktree --result ok`, o `--result rechazado` si el script salió con 1.

## Cuál worktree

- **En un repo solo:** la persona abre la sesión con `claude --worktree <nombre>`, o en el escritorio con worktree, y el arnés hace el resto al arrancar: enlaza las dependencias, mueve los puertos y toma la rama del worktree como la del issue. No hace falta esta skill.
- **En una carpeta multi-repo:** `--worktree` no sirve, porque la raíz es el repo de carpeta y los repos anidados no entran en el worktree. Ahí es `/arnes:worktree open`, que abre un worktree por repo, y también para las tareas de un mismo issue.

## Cuándo no hace falta

Si los agentes tocan archivos disjuntos, trabajan en el mismo árbol, uno detrás de otro o en paralelo, sin ramas: no hay nada que integrar. Un worktree sirve cuando dos tareas del mismo issue chocarían en los mismos archivos, o cuando otra sesión ya trabaja en este árbol (docs/PLAN.md §7).

## open <slug>

1. El checkout principal de cada workspace tiene que estar en la rama del issue, nunca en la rama por defecto. Si está en `main`, propón crear la rama del issue con el `integration.branchPrefix` del manifiesto y el número del issue, y créala solo con el visto bueno de la persona.
2. Corre `open <slug>`. El slug va en kebab-case y describe la tarea, como `crud-talleres-back`. Agrega `--ws` para limitar el set a esos workspaces (sin `--ws`, abre uno por repo adoptable) y `--issue` con el número o la URL.
   - El worktree nace usable: `node_modules` enlazado al del checkout principal y los `.env*` copiados, para que verify corra adentro y la persona pueda levantar la app ahí.
   - **`--no-link`** cuando el issue regenera algo dentro de `node_modules`, como un cambio de `prisma/schema.prisma` (`prisma generate`): con el enlace, regenerar en el worktree pisaría el del principal. Instala las dependencias dentro del worktree y tarda; pídele el sí a la persona.
   - **Puertos:** el set toma un desplazamiento (10 el primero, 20 el segundo) y las copias de `.env` lo llevan, para que su app corra al lado de la del principal. `--port-offset N` lo elige la persona; `--port-offset 0` no toca nada.
3. Di en pocas líneas la carpeta de cada worktree y el mapa de puertos (`set <slug>: api 3003 → 3013, …`): la app del worktree se arranca desde su carpeta con esos puertos. Si open avisó que Prisma carga el `.env` del principal, se arranca con el del worktree ya cargado: `node --env-file=.env <entrada>`. Quien trabaje ahí (un agente, u otra sesión con `cd` a esa ruta) commitea en su rama `wt/...`; nunca pushea ni mergea.
4. El guard exige bandera vigente para commitear también dentro del worktree: allí se verifica antes de cada commit.

## integrate <slug>

1. Comprueba que el trabajo del worktree está commiteado. El script se niega si hay cambios sin commitear.
2. Corre `integrate <slug>`. Hace `git merge --no-ff` de cada rama del set en la rama del issue, quita los enlaces y las copias de `.env` del worktree, borra el worktree y la rama, y marca el registro como `integrado`. Si dice que no pudo deshacer algo, muestra lo que quedó y para: nunca borres el worktree a mano, porque un `git worktree remove` con un enlace vivo borra el `node_modules` del principal.
3. Si sale con 1 por conflicto, el merge queda a medias en el checkout principal:
   - Lista los archivos en conflicto y resuelve cada uno leyendo los dos lados. Nunca uses `checkout --ours` ni `--theirs` en masa.
   - Verifica el workspace (skill verify) y commitea el merge con `git commit --no-edit`.
   - Vuelve a correr `integrate <slug>` para borrar el worktree y cerrar el registro.
4. Después de integrar, verifica lo que entró con el merge: carga la skill verify con `--base <primer padre>`, el de `git -C "<carpeta>" rev-parse HEAD^1`. Contra HEAD no vería nada, porque el merge ya está commiteado.
5. Di en una línea cómo quedó el registro (`list --all`).

## close <slug>

Cierra un worktree sin commits propios, por ejemplo una tarea descartada antes de empezar. Si la rama tiene commits sin integrar, el script se niega. No lo fuerces: o se integra, o la persona lo borra desde su terminal. Di en una línea cómo quedó el registro.

## list y pending

`list` muestra los abiertos con el mapa de puertos de cada set, y `list --all` también los integrados y cerrados. `pending` sale con 1 si queda algo sin integrar; ship y el Stop lo consultan. Di cada worktree en una línea, con su rama, su destino y su mapa de puertos.

El Stop bloquea un turno que dejó commits sin integrar en un worktree del issue. SessionStart lista los pendientes y avisa de los que llevan más de 7 días sin commits nuevos. Ningún hook borra un worktree solo.

Lo que lee la persona (docs/PLAN.md §2): lo de arriba, sin nombres de scripts, códigos de salida ni rutas del plugin. La salida completa de cada subcomando va al informe: `node "${CLAUDE_PLUGIN_ROOT}/scripts/informe.js" path worktree` da la ruta, y el chat la dice en una línea.
