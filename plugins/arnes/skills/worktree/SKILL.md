---
name: worktree
description: Ver e integrar los worktrees que el arnés tiene registrados para el issue, los de los devs que build lanzó aislados cuando dos tareas chocaban en los mismos archivos. Integrar es git merge --no-ff en la rama del issue, nunca squash. Para trabajar un issue no hace falta, porque para eso está el worktree nativo de Claude Code.
argument-hint: "integrate <nombre> | close <nombre> | list [--all] | pending"
disable-model-invocation: true
---

# arnes:worktree

Argumentos: `$ARGUMENTS`

Todo pasa por `node "${CLAUDE_PLUGIN_ROOT}/scripts/worktree-ledger.js" <subcomando>`, con la ruta entre comillas y desde el directorio de la sesión. El script usa el registro del checkout de la sesión: el principal, o el worktree nativo en que trabaja. No uses `git worktree` ni `git branch -D` a mano: el registro quedaría desfasado.

Antes de nada, anota `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start worktree --detail "<subcomando> <nombre>"`. Al terminar, anota `end worktree --result ok`, o `--result rechazado` si el script salió con 1.

## Cuál worktree

- **Para trabajar un issue**, en un repo solo y en una carpeta multi-repo: el worktree nativo de Claude Code. Plan manda la sesión a uno antes de planificar (la raíz es la puerta), o la persona abre la sesión con `claude --worktree <nombre>`, o el escritorio en modo worktree. No hace falta esta skill.
- **Para dos tareas que chocan en los mismos archivos**, build lanza al dev con el aislamiento de Claude Code (`isolation: worktree`), que le da un worktree `agent-<id>` en la rama `worktree-agent-<id>`. El arnés lo anota en el registro al arrancar el dev, le enlaza las dependencias, y build lo integra al cerrar su workspace. Esta skill sirve cuando eso quedó a medias: un conflicto, una sesión cortada, o un pendiente que avisan el Stop, ship o SessionStart.

## integrate <nombre>

1. Corre `integrate <nombre>`, con el nombre que dio `pending` (`agent-<id>`). Commitea en la rama del agente lo que dejó sin commitear, hace `git merge --no-ff` en la rama del issue, quita los enlaces sin seguirlos, borra el worktree y la rama, y marca el registro como `integrado`. Si dice que no pudo deshacer algo, muestra lo que quedó y para: nunca borres el worktree a mano, porque un `git worktree remove` con un enlace vivo borra el `node_modules` del principal.
2. Si sale con 1 por conflicto, el merge queda a medias en el checkout:
   - Lista los archivos en conflicto y resuelve cada uno leyendo los dos lados. Nunca uses `checkout --ours` ni `--theirs` en masa.
   - Verifica el workspace (skill verify) y commitea el merge con `git commit --no-edit`.
   - Vuelve a correr `integrate <nombre>` para borrar el worktree y cerrar el registro.
3. Después de integrar, verifica lo que entró con el merge: carga la skill verify con `--base <primer padre>`, el de `git -C "<carpeta>" rev-parse HEAD^1`. Contra HEAD no vería nada, porque el merge ya está commiteado.
4. Di en una línea cómo quedó el registro (`list --all`).

## close <nombre>

Borra un worktree registrado sin trabajo propio, por ejemplo el de una tarea descartada. Si tiene commits o archivos sin integrar, el script se niega. No lo fuerces: o se integra, o la persona lo borra desde su terminal. Di en una línea cómo quedó el registro.

## list y pending

`list` muestra los abiertos con lo que tienen sin integrar, y `list --all` también los integrados, cerrados y retirados (los que Claude Code borró porque el dev no dejó cambios). `pending` sale con 1 si queda algo sin integrar; ship y el Stop lo consultan. Di cada worktree en una línea, con su rama, su destino y lo que tiene sin integrar.

El Stop bloquea un turno que dejó trabajo sin integrar en un worktree del issue. SessionStart lista los pendientes y avisa de los que llevan más de 7 días sin actividad. Ningún hook borra un worktree con trabajo.

Lo que lee la persona (docs/PLAN.md §2): lo de arriba, sin nombres de scripts, códigos de salida ni rutas del plugin. La salida completa de cada subcomando va al informe: `node "${CLAUDE_PLUGIN_ROOT}/scripts/informe.js" path worktree` da la ruta, y el chat la dice en una línea.
