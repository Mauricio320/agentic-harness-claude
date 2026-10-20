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

1. Si ya existe algún `.claude/harness.json` en la carpeta o en sus repos, léelo antes de seguir. No lo pises sin que la persona lo pida.
2. Corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/init-draft.js"`. Imprime los borradores en stdout, y en stderr lo no adoptable y lo pendiente. Si sale con 2, explica el motivo y detente.
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
7. Ofrece correr `/arnes:init --check` para ver qué falta del mínimo de adopción.

Un repo con solo `composer.json` (PHP) o sin typecheck ni test detectables no lleva manifiesto propio. Entra en la composición como no adoptable todavía, y eso no es un error.

El verde del arnés significa que cumple convenciones y compila/testea, nunca que sea correcto en el negocio. Dilo así si la persona pregunta qué garantiza.
