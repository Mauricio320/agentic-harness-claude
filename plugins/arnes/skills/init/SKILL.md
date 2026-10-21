---
name: init
description: Genera y valida los manifiestos .claude/harness.json de un proyecto, uno por repo y la composición de la carpeta si es multi-repo; con --check comprueba el mínimo de adopción.
argument-hint: "[--check]"
disable-model-invocation: true
---

# arnes:init

Argumentos: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node`, con la ruta entre comillas, desde el directorio donde la persona abrió la sesión. No uses bash ni jq: el mismo comando tiene que servir en PowerShell, Git Bash y CI.

## Con --check

1. Corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/adoption-check.js"`.
2. Muestra la salida tal cual y después un resumen de una línea por FALTA, con lo que hay que hacer para cerrarla.
3. MANUAL es configuración del host git que no se puede verificar desde aquí. NO ADOPTABLE es un repo sin manifiesto propio y no bloquea. Ninguna de las dos es una falta.
4. No modifiques ningún archivo. Termina ahí.

## Sin argumentos: generar los manifiestos

Hay dos niveles (docs/PLAN.md §5):
- `<repo>/.claude/harness.json`: un manifiesto por repo con sus comandos. Es el que lee el CI de ese repo.
- `<carpeta>/.claude/harness.json`: si la carpeta contiene repos anidados, una composición que los lista y agrega solo lo que existe entre repos (`integration`, `contract`).

Pasos:

1. Si ya existe algún `.claude/harness.json` en la carpeta o en sus repos, léelo antes de seguir. No lo pises sin que la persona lo pida: para completarlo, ve a "Completar un manifiesto existente" abajo.
2. Corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/init-draft.js"`. Imprime los borradores en stdout, y en stderr lo no adoptable, lo pendiente y la rama de cada repo sin manifiesto. Si sale con 2, explica el motivo y detente. Si dice que una rama remota sí trae el manifiesto, detente: la persona está en la rama equivocada. Pídele `git fetch`, cambiarse a esa rama y volver a correr init; no propongas manifiestos desde cero.
3. Muestra cada borrador con su ruta y pregunta, en un solo mensaje, por lo que el script no puede inferir:
   - `riskPaths` de cada workspace: rutas cuyo cambio exige revisión humana (migraciones, auth, permisos, pagos).
   - En la composición: `contract` de cada repo (globs que provee o consume) e `integration` (`branchPrefix`, `sameBranchAcrossWorkspaces`).
   - Opcionales: `sharedPaths` (código compartido que obliga a correr la suite completa), `codeGlobs`, `commands.typecheckFast` y `memory`.
   - Nombres de workspace más cortos si la persona los prefiere (por ejemplo `api`, `front`).
   Propón valores solo si los ves en el código o en el `CLAUDE.md` del repo, y di de dónde salen. Nunca inventes comandos: si no hay lint o tests, el campo queda ausente.
4. Con el visto bueno, corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/init-draft.js" --write` (con `--force` solo si la persona aceptó pisar un existente). Aplica con Edit las correcciones que dictó.
5. Valida cada archivo escrito con `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" validate <archivo>`. Valida además el proyecto resuelto con `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show`. Si algo no valida, corrígelo antes de seguir.
6. Recuerda dónde se versiona cada archivo:
   - El manifiesto de un repo se commitea en ese repo, cuando su equipo lo adopte. Tú no commiteas.
   - La composición va en el repo-workspace de la carpeta. Si la carpeta no es un repo, o si su repo es otro (como el del arnés en academico), va a su `.gitignore`.
7. Sigue con lo determinista de la adopción, y después ofrece `/arnes:init --check` para ver qué falta del mínimo.

## Completar un manifiesto existente

Si los manifiestos ya existen, no los regeneres. Corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/adopt.js" complete` y muestra su salida tal cual: una línea `falta` por campo que el borrador traería y el manifiesto no (`conventions`, entradas de `forbidden`, `contract` de la composición).
1. Pregunta en un solo mensaje, campo por campo, cuáles agregar. Di de dónde sale cada uno: `conventions` son las cuatro del borrador, `forbidden` lo que toca una base o corre `--fix`, y `contract` los globs de su stack que tienen archivos.
2. Con el sí, `adopt.js complete --only <campo> --write`, un `--only` por campo aceptado. Agrega solo eso y no toca lo que ya está.
3. Valida con `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show`.

## Después de los manifiestos: lo determinista

Corre cada paso con `node "${CLAUDE_PLUGIN_ROOT}/scripts/adopt.js" <paso>` y muestra su salida tal cual. Los que escriben (`--write`, `--remove`) solo con un sí de la persona, pedido en un mensaje que los liste todos. init no instala dependencias ni commitea.
1. **Tests legibles:** `probe` corre el test del manifiesto sobre un spec. Si dice FALTA con un flag (`--verbose`, `--reporters=default`), propón agregarlo a `commands.test`.
2. **Hooks del arnés anterior:** `hooks` los lista; con el sí, `hooks --remove`.
3. **Permisos:** `permissions` muestra los que faltan; con el sí, `permissions --write` los agrega a `.claude/settings.local.json`, que no se commitea.
4. **CLAUDE.md de la carpeta:** en una carpeta multi-repo, `claude-md` muestra el borrador; con el sí, `claude-md --write`, y la persona lo completa.
5. **Línea base:** por workspace, `baseline <ws>` dice si el árbol está limpio; con el sí, `baseline <ws> --write` escribe `tests/baseline.json` y agrega a `tests/known-failures.txt`, con la fecha de hoy, los rojos que ya había. Commitearlos, con `gates:` en el asunto, es de la persona.
6. Si un comando no corre porque falta una dependencia, dilo con el comando: instalarla es de la persona.

Un repo con solo `composer.json` (PHP) o sin typecheck ni test detectables no lleva manifiesto propio. Entra en la composición como no adoptable todavía, y eso no es un error.

El verde del arnés significa que cumple convenciones y compila/testea, nunca que sea correcto en el negocio. Dilo así si la persona pregunta qué garantiza.
