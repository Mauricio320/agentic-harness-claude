---
name: sync
description: Traer a la rama actual lo nuevo de origin/<rama> (por defecto la defaultBranch de cada workspace), por workspace. Primero mira si hay algo que traer y, si no lo hay, lo dice en una línea y no toca nada; si lo hay, respaldo, merge, la lista de lo que de verdad se combinó y verify al final.
argument-hint: "[rama] [--ws <workspace>]..."
disable-model-invocation: true
---

# arnes:sync

Argumentos: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas. Cada comando de git va con `git -C "<carpeta del workspace>"`. No hay push.

1. Anota `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start sync`.
2. Elige los workspaces: los de `--ws`, o todos los adoptables de `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show`. La rama a traer es el argumento, o la `defaultBranch` de cada workspace. Haz los pasos 4 a 8 en cada uno que tenga algo que traer.
3. Qué hay que traer, antes de tocar nada:
   - Sin rama en los argumentos, `node "${CLAUDE_PLUGIN_ROOT}/scripts/issue-branch.js" behind` hace el fetch de cada repo y nombra los que van atrás de su rama por defecto; sale con 1 si alguno va atrás, y no es una falla.
   - Con una rama en los argumentos, en cada workspace `git -C "<dir>" fetch origin <rama>` y `git -C "<dir>" merge-base --is-ancestor origin/<rama> HEAD`: si sale con 0, ese workspace ya la tiene.
   - **Si ningún workspace tiene nada que traer** (`todas las ramas al día con origin`), termina aquí: sin respaldos, sin informe y sin verify. Anota `end sync --result ok --detail "al día"` y dilo en una línea. En un worktree recién creado es lo normal, porque cada repo llegó desde origin al día: dilo así.
   - Si alguno tiene, sigue solo con esos.
4. Precondiciones:
   - Árbol limpio: `node "${CLAUDE_PLUGIN_ROOT}/scripts/touched-files.js" --ws <ws>` no lista nada.
   - Ningún merge a medias.
   - La rama actual no es la que se trae.
   Si alguna falla, detente en ese workspace y di qué falta. No hagas stash por tu cuenta.
5. Respaldo: `git -C "<dir>" branch "respaldo/<rama-actual>-<AAAAMMDD-HHMM>"`. Anota el nombre: es la vuelta atrás.
6. `git -C "<dir>" merge origin/<rama>`; el fetch ya se hizo en el paso 3. Nunca uses `--squash`, `rebase` ni `--strategy-option theirs`.
   - Conflictos: lista los archivos con `git diff --name-only --diff-filter=U` y resuelve cada uno leyendo los dos lados. Nunca uses `checkout --ours` ni `--theirs` en masa. El commit del merge exige bandera vigente: verifica primero (paso 8) y después `git commit --no-edit`.
7. `node "${CLAUDE_PLUGIN_ROOT}/scripts/merged-files.js" --ws <ws>`: las líneas `ambos` son los archivos que cambiaron los dos lados, donde un merge limpio puede esconder una incompatibilidad. Si sale con 1, el merge fue fast-forward y no se combinó nada.
8. Verify al final con la skill verify, sobre los workspaces que trajeron algo, con `--base <respaldo>`: el merge ya está commiteado, y contra HEAD no vería nada. Revisa con atención los archivos `ambos`, y también los contratos entre repos (`contract`) si alguno de ellos los toca.
9. El reporte (docs/PLAN.md §2), sin nombres de scripts, códigos de salida, hashes ni rutas del plugin:
   - **El detalle va al informe:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/informe.js" path sync` da la ruta. Escribe ahí, por workspace, el respaldo creado, los commits que entraron (`git -C "<dir>" log --oneline <respaldo>..HEAD --no-merges`), los conflictos y cómo se resolvió cada uno, los archivos `ambos` y el resultado de verify.
   - **En el chat:** una línea por workspace (cuántos commits entraron, si hubo conflictos y si verify quedó en verde), la ruta del informe, y lo que le toca a la persona. Para volver atrás, corre en su terminal `git reset --hard <respaldo>`; el guard no se lo deja al modelo. Cuando ya no haga falta, el respaldo se borra con `git branch -d`.
10. Anota `end sync --result ok`, o `--result fail` si verify quedó en rojo o quedó un conflicto sin resolver.
