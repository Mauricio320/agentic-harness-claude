# Probar el arnés: guía para probadores

Versión 0.5.1, desde la rama `feature/pre-piloto`. Probada con Claude Code 2.1.304 y Node 24 en Windows. El diseño está en `docs/PLAN.md`, y `docs/como-funciona.html` lo explica desde cero.

## 1. Instalar

Claude Code clona con `git` sin preguntar credenciales: la de GitLab tiene que estar guardada antes (Git Credential Manager). Después, en cualquier terminal:

```
claude plugin install arnes --marketplace "https://gitlab.com/preupdv/apps/agentic-harness.git#feature/pre-piloto"
claude plugin install arnes-ui@agentic-harness
claude plugin list
```

El primero agrega a tu `settings.json` de usuario el marketplace `agentic-harness`, fijado a la rama, e instala `arnes`. El segundo instala el mod de interfaz desde ese mismo marketplace. `claude plugin list` muestra los dos con `Version: 0.5.1`. `arnes-mod` no existe todavía (fase 5).

Para recibir una versión nueva de la rama: `claude plugin marketplace update agentic-harness` y después `claude plugin update arnes@agentic-harness` (y lo mismo con `arnes-ui`). Solo llega si subió `version` en `plugin.json`. Para quitarlo todo: `claude plugin marketplace remove agentic-harness`.

## 2. Permisos recomendados

Sin ellos el arnés funciona igual, pero pregunta en cada script. Van en `~/.claude/settings.json`, o en el de la carpeta de `CLAUDE_CONFIG_DIR`. Cambia `<usuario>` y deja solo los comandos de test de tu repo. El porqué de cada regla está en el README, en la sección "Permisos recomendados".

```json
{
  "permissions": {
    "allow": [
      "Bash(node \"C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/*)",
      "PowerShell(node \"C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/*)",
      "Bash(git status *)", "Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
      "Bash(git rev-parse *)", "Bash(git ls-files *)", "Bash(git merge-base *)",
      "Bash(npx tsc --noEmit *)", "Bash(npx tsc -p *)", "Bash(npx jest *)", "Bash(npx eslint *)",
      "PowerShell(npx jest *)", "PowerShell(npx eslint *)",
      "Bash(graphify query *)", "Bash(graphify explain *)", "Bash(graphify path *)",
      "Bash(glab issue view *)", "Bash(gh issue view *)"
    ],
    "ask": ["Bash(npx eslint *--fix*)", "PowerShell(npx eslint *--fix*)"]
  }
}
```

## 3. Adoptar un repo

1. Quita de `.claude/settings.json` del repo, y del de la carpeta si es multi-repo, los hooks que corren scripts de `.claude/hooks/`. Son del arnés anterior: corren además de los del plugin y niegan lo que el arnés deja pasar.
2. Abre Claude Code en el repo, o en la carpeta que contiene varios, y corre `/arnes:init`. Detecta el stack, los comandos y el formato de los specs, muestra los borradores de `.claude/harness.json` y te pregunta lo que no puede inferir: las `riskPaths` de cada workspace y, en una carpeta, `contract` e `integration`. Con tu visto bueno los escribe y los valida. No commitea.
3. `/arnes:init --check` corre las ocho comprobaciones del mínimo de adopción (`docs/PLAN.md` §8). Cada una sale `ok`, `FALTA`, `MANUAL` (configuración del host git que no se ve desde local) o `NO ADOPTABLE` (un repo sin manifiesto propio, como uno PHP, que no bloquea).
4. La comprobación 8 es la línea base de tests. Se captura con `node "C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/0.5.1/scripts/test-baseline.js" capture <workspace>` y se commitea con `gates:` al inicio del asunto. Los rojos que ya existían van en `tests/known-failures.txt`, una línea por test: `AAAA-MM-DD | <spec> | <nombre completo>`.

## 4. Qué vas a ver

Pide el trabajo como siempre, sin comandos: "Implementa este issue: …". El modelo escribe el plan en `.tmp/harness/plan.md` y te pide aprobarlo. Con tu aprobación corre solo build, verify y review. El commit y el push los pides tú con `/arnes:ship`.

Con `arnes-ui`:
- **La banda**, una línea sobre el prompt: la etapa y su tiempo, los agentes vivos, y por workspace las marcas del gate, los archivos editados, la bandera y los worktrees sin integrar. Por ejemplo: `arnes ▸ Revisando (reviewer) 00:42 · reviewer opus 00:42 · api ✓tsc ✓tests ⏳review ✎3 ✓flag`.
- **La status line**: `⚠arnes-ui: <etapa>`. El prefijo lo pone Claude Code.
- **El panel**, con `/arnes-panel`. Se abre solo desde 144 columnas. Trae:
  - la cronología, con la duración y el costo de cada etapa, y el promedio de las últimas corridas;
  - los agentes, con su modelo, tiempo, última herramienta, tokens y costo, y el botón "ver" para entrar a su transcript;
  - el gate por workspace, los worktrees sin integrar, el título del plan, las últimas líneas de la timeline y "Lo que sigue".
- **Los avisos**, como toast y como línea del transcript: el Stop bloqueó el turno, gate en rojo (solo por ci-gate), zona de riesgo tocada y contexto compactado. Al cerrar cada turno: `arnes · corrida: … · más lenta: … · más cara: …`.

## 5. Comandos

- **Solo los invocas tú:** `/arnes:init [--check]`, `/arnes:ship [--solo-commit] [<rama>]`, `/arnes:worktree open <slug> | integrate <slug> | close <slug> | list | pending` y `/arnes:sync`.
- **Los carga el modelo cuando corresponde, y también puedes invocarlos:** `/arnes:plan <issue>`, `/arnes:build`, `/arnes:verify`, `/arnes:review`, `/arnes:memory decision | gotcha | recall` y `/arnes:timeline`.
- **Del mod:** `/arnes-panel` abre o cierra el panel.

## 6. Limitaciones conocidas de 0.5.1

- **REVISIÓN HUMANA OBLIGATORIA.** Si el cambio toca `riskPaths`, el arnés lo marca en el plan, en el reporte del reviewer, en ship y en el cuerpo del MR. No aprueba por nadie: esa aprobación la da una persona en GitLab.
- **Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.** El reviewer tampoco lo certifica: busca lo que está en su lista cerrada.
- **La bandera de verificación** dura 30 minutos y cubre solo los archivos tocados. La garantía real es el CI.
- **Errores en tiempo de ejecución.** Lo que solo se ve arrancando la app, como un error de inyección de dependencias, no lo detectan ni tsc ni jest.
- **Las correcciones de review.** Hay dos rondas de corrección como máximo, y las acotadas van en sonnet. En el tope, el arnés se detiene y te lo reporta.
- **El typecheck tras cada edición** solo corre si el manifiesto declara `commands.typecheckFast`. Si no, espera a verify.
- **Los worktrees de `/arnes:worktree`** no copian `.env` ni enlazan `node_modules`.
- **Avisos de `arnes-ui`.** En algunas terminales los toasts no se ven, como en la de Muxentra dentro de VS Code. Los avisos importantes salen también en el transcript.
- **Costos y panel de `arnes-ui`.** El costo de un agente incluye lo que gastaron los que corrieron al mismo tiempo. Falta confirmar en una sesión real la corrección de la línea `Plan:` del panel.
- **Los mods** solo cargan en sesiones locales.
- **Instalado desde una rama,** `/arnes:init --check` da FALTA en la comprobación 6, que pide el plugin fijado a un tag `vX.Y.Z`. Es lo esperado mientras se prueba la rama.

## 7. Reportar un problema

Abre un issue en https://gitlab.com/preupdv/apps/agentic-harness/-/issues con:
- **Qué pasó:** qué pediste, qué esperabas y el texto exacto que viste, más la salida de `claude --version` y de `claude plugin list`.
- **La timeline:** la salida de `/arnes:timeline`, o el archivo `.tmp/harness/timeline.jsonl`.
- **El lock de sesión:** los archivos de `.tmp/harness/sessions/`.
- **La salida del gate:** el bloque de ci-gate del reporte de verify, o la salida de correrlo tú desde la raíz del proyecto: `node "C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/0.5.1/scripts/ci-gate.js" --ws <workspace> --base HEAD`. Suma la bandera `.tmp/harness/gate/<workspace>.json` si existe.
- **Si el problema es de plan o de review:** `.tmp/harness/plan.md` y la carpeta `.tmp/harness/review/`.

`.tmp/harness/` está en la raíz del proyecto: el repo, o la carpeta en un proyecto multi-repo. Revisa lo que adjuntas: la timeline y el plan llevan texto del issue. Nunca adjuntes `.env` ni credenciales.
