---
name: sync
description: Traer a la rama actual lo nuevo de origin/<rama> (por defecto la defaultBranch de cada workspace), por workspace, con respaldo, fetch, merge, la lista de lo que de verdad se combinó y verify al final.
argument-hint: "[rama] [--ws <workspace>]..."
disable-model-invocation: true
---

# arnes:sync

Argumentos: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas. Cada comando de git va con `git -C "<carpeta del workspace>"`. No hay push.

1. Anota `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start sync`.
2. Elige los workspaces: los de `--ws`, o todos los adoptables de `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show`. La rama a traer es el argumento, o la `defaultBranch` de cada workspace. Haz los pasos 3 a 7 en cada uno.
3. Precondiciones:
   - Árbol limpio: `node "${CLAUDE_PLUGIN_ROOT}/scripts/touched-files.js" --ws <ws>` no lista nada.
   - Ningún merge a medias.
   - La rama actual no es la que se trae.
   Si alguna falla, detente en ese workspace y di qué falta. No hagas stash por tu cuenta.
4. Respaldo: `git -C "<dir>" branch "respaldo/<rama-actual>-<AAAAMMDD-HHMM>"`. Anota el nombre: es la vuelta atrás.
5. `git -C "<dir>" fetch origin <rama>`, y después `git -C "<dir>" merge origin/<rama>`. Nunca uses `--squash`, `rebase` ni `--strategy-option theirs`.
   - `Already up to date`: no hay nada que traer en ese workspace.
   - Conflictos: lista los archivos con `git diff --name-only --diff-filter=U` y resuelve cada uno leyendo los dos lados. Nunca uses `checkout --ours` ni `--theirs` en masa. El commit del merge exige bandera vigente: verifica primero (paso 7) y después `git commit --no-edit`.
6. `node "${CLAUDE_PLUGIN_ROOT}/scripts/merged-files.js" --ws <ws>`: las líneas `ambos` son los archivos que cambiaron los dos lados, donde un merge limpio puede esconder una incompatibilidad. Si sale con 1, el merge fue fast-forward y no se combinó nada.
7. Verify al final con la skill verify, sobre los workspaces que trajeron algo. Revisa con atención los archivos `ambos`, y también los contratos entre repos (`contract`) si alguno de ellos los toca.
8. El reporte (docs/PLAN.md §2), sin nombres de scripts, códigos de salida, hashes ni rutas del plugin:
   - **El detalle va al informe:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/informe.js" path sync` da la ruta. Escribe ahí, por workspace, el respaldo creado, los commits que entraron (`git -C "<dir>" log --oneline <respaldo>..HEAD --no-merges`), los conflictos y cómo se resolvió cada uno, los archivos `ambos` y el resultado de verify.
   - **En el chat:** una línea por workspace (cuántos commits entraron, si hubo conflictos y si verify quedó en verde), la ruta del informe, y lo que le toca a la persona. Para volver atrás, corre en su terminal `git reset --hard <respaldo>`; el guard no se lo deja al modelo. Cuando ya no haga falta, el respaldo se borra con `git branch -d`.
9. Anota `end sync --result ok`, o `--result fail` si verify quedó en rojo o quedó un conflicto sin resolver.
