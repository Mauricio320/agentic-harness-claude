# Probar el arnés: guía para probadores

Versión 0.5.3, desde la rama `feature/pre-piloto-3`. Probada con Claude Code 2.1.304 y Node 24 en Windows; la 0.5.2 corrió también en Mac. El diseño está en `docs/PLAN.md`, y `docs/como-funciona.html` lo explica desde cero.

## 1. Instalar

Claude Code clona con `git` sin preguntar credenciales: la de GitLab tiene que estar guardada antes (Git Credential Manager). Después, en cualquier terminal:

```
claude plugin install arnes --marketplace "https://gitlab.com/preupdv/apps/agentic-harness.git#feature/pre-piloto-3"
claude plugin install arnes-ui@agentic-harness
claude plugin list
```

El primero agrega a tu `settings.json` de usuario el marketplace `agentic-harness`, fijado a la rama, e instala `arnes`. El segundo instala el mod de interfaz desde ese mismo marketplace. `claude plugin list` muestra los dos con `Version: 0.5.3`. `arnes-mod` no existe todavía (fase 5).

Para recibir una versión nueva de la rama: `claude plugin marketplace update agentic-harness` y después `claude plugin update arnes@agentic-harness` (y lo mismo con `arnes-ui`). Solo llega si subió `version` en `plugin.json`. Para quitarlo todo: `claude plugin marketplace remove agentic-harness`.

Trabaja en la terminal y con opus como modelo de la sesión principal (`/model opus`): con él, las skills del arnés se cargan solas con más fiabilidad, y el plan, que es obligatorio, sale sin que lo pidas. Los devs y los test-writers van en sonnet igual, porque así los define el arnés. El mod `arnes-ui` se ve solo en la terminal: no en el chat de la extensión de VS Code ni en el de Claude Desktop. En los dos sirve la terminal integrada.

## 2. Permisos recomendados

Sin ellos el arnés funciona igual, pero pregunta en cada script. `/arnes:init` los arma con los comandos de tu manifiesto y, con tu sí, los escribe en `.claude/settings.local.json` del proyecto (§3). Para tenerlos en todos tus proyectos van en `~/.claude/settings.json`, o en el de la carpeta de `CLAUDE_CONFIG_DIR`. En ese caso cambia `<usuario>` y deja solo los comandos de test de tu repo. El porqué de cada regla está en el README, en la sección "Permisos recomendados".

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

1. Haz `git fetch` y comprueba que cada repo esté en la rama que trae `.claude/harness.json`. Si un repo no lo tiene, init te dice en qué rama está y qué rama remota sí lo trae; cámbiate antes de seguir.
2. Instala las dependencias del repo (`npm ci` o la que use): init no instala nada.
3. Abre Claude Code en el repo, o en la carpeta que contiene varios, y corre `/arnes:init`. Detecta el stack, los comandos y el formato de los specs, muestra los borradores de `.claude/harness.json` y te pregunta lo que no puede inferir: las `riskPaths` de cada workspace y, en una carpeta, `contract` e `integration`. En una carpeta con back y front, declara `contract`: sin él, ship no sabe que el back va primero. Con tu visto bueno escribe los manifiestos y los valida.
4. Después, init ofrece lo determinista de la adopción y te pide un sí antes de escribir nada:
   - prueba que la salida del test del manifiesto se pueda leer y, si no, te dice el flag que falta (`--verbose`, o `--reporters=default` si tu config de jest trae un reporter propio);
   - quita de los `.claude/settings.json` los hooks del arnés anterior, que niegan lo que el arnés deja pasar;
   - escribe los permisos de §2;
   - en una carpeta multi-repo, escribe el borrador del `CLAUDE.md` de la carpeta, para que lo completes;
   - con el árbol limpio, captura la línea base de tests y anota en `tests/known-failures.txt`, con la fecha de hoy, los rojos que ya había.
   init no commitea: la línea base y las fallas conocidas las commiteas tú, con `gates:` al inicio del asunto.
5. `/arnes:init --check` corre las ocho comprobaciones del mínimo de adopción (`docs/PLAN.md` §8). Cada una sale `ok`, `FALTA`, `MANUAL` (configuración del host git que no se ve desde local) o `NO ADOPTABLE` (un repo sin manifiesto propio, como uno PHP, que no bloquea).

## 4. Qué vas a ver

Pide el trabajo como siempre, sin comandos: "Implementa este issue: …". El modelo escribe el plan en `.tmp/harness/plan.md` y te pide aprobarlo. El plan es obligatorio: hasta que lo apruebes en un mensaje tuyo, el arnés no deja escribir código. Para un cambio mínimo, escribe tú `/arnes:plan --trivial <el pedido>`, que deja un plan de una pantalla aprobado. Con tu aprobación corre solo build, verify y review, sin detenerse entre etapas aunque te haga una pregunta en el camino. verify revisa primero las convenciones del manifiesto (comentarios, `as unknown as`, `console.`, TODO), y el dev las corrige antes de entregar. El commit y el push los pides tú con `/arnes:ship`.

Los comandos que tocan una base no los corre la sesión: los scripts con sync, migrate, migrar, push, deploy, seed o reset en el nombre, y las escrituras de prisma, typeorm o knex, van en `forbidden`, y el guard los niega. Córrelos tú desde tu terminal, sabiendo contra qué base apunta tu `.env`: un proxy en `127.0.0.1` puede ser QA.

Con `arnes-ui`:
- **La banda**, una línea sobre el prompt: la etapa y su tiempo, los agentes vivos, por workspace las marcas del gate, los archivos editados, la bandera y los worktrees sin integrar, y al final el reloj y el costo de la sesión. Por ejemplo: `arnes ▸ Revisando 00:42 · reviewer opus 00:42 · api ✓tsc ✓tests ⏳review ✎3 ✓flag · 42:13 $3.10`.
- **La status line**: `⚠arnes-ui: <etapa>`. El prefijo lo pone Claude Code.
- **El panel**, con `/arnes-panel`. Se abre solo desde 144 columnas. Trae:
  - en la cabecera, el proyecto, la etapa y la sesión, con su reloj y su costo;
  - la cronología de la corrida, desde el último plan: la duración y el costo de cada etapa, la espera de la persona, el total en etapas y el promedio de las últimas corridas;
  - los agentes, con su modelo, tiempo, última herramienta, tokens (`57k tok + 1.2M de caché`: los nuevos y las lecturas de caché) y costo, y el botón "ver" para entrar a su transcript;
  - el gate por workspace, los worktrees sin integrar, el título del plan, las últimas líneas de la timeline y "Lo que sigue".
- **Los avisos**, como toast y como línea del transcript: el Stop bloqueó el turno, gate en rojo (solo por ci-gate), zona de riesgo tocada y contexto compactado. Al terminar ship: `arnes · corrida: … · más lenta: … · más cara: …`.

Sin el mod también hay avisos: el Stop dice `verificado, falta review` cuando cierras un turno con la verificación hecha y sin revisión. `/arnes:timeline` muestra el tiempo y el costo de cada etapa, y la espera de la persona.

## 5. Comandos

- **Solo los invocas tú:** `/arnes:plan --trivial <pedido>`, `/arnes:init [--check]`, `/arnes:ship [--solo-commit] [<rama>]`, `/arnes:worktree open <slug> | integrate <slug> | close <slug> | list | pending` y `/arnes:sync`.
- **Los carga el modelo cuando corresponde, y también puedes invocarlos:** `/arnes:plan <issue>`, `/arnes:build`, `/arnes:verify`, `/arnes:review`, `/arnes:memory decision | gotcha | recall` y `/arnes:timeline`.
- **Del mod:** `/arnes-panel` abre o cierra el panel.

## 6. Limitaciones conocidas de 0.5.3

- **REVISIÓN HUMANA OBLIGATORIA.** Si el cambio toca `riskPaths`, el arnés lo marca en el plan, en el reporte del reviewer, en ship y en el cuerpo del MR. No aprueba por nadie: esa aprobación la da una persona en GitLab.
- **Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.** El reviewer tampoco lo certifica: busca lo que está en su lista cerrada.
- **La bandera de verificación** dura 30 minutos y cubre solo los archivos tocados. La garantía real es el CI.
- **Un hook pre-commit que reescribe archivos**, como `eslint --fix`, hace que ship se detenga con FALLA después del commit, con los archivos que cambiaron. Decides tú.
- **Errores en tiempo de ejecución.** Lo que solo se ve arrancando la app, como un error de inyección de dependencias, no lo detectan ni tsc ni jest.
- **Las rondas de review.** La primera revisa todo en opus. Las siguientes revisan solo lo que cambió, en sonnet, y vuelven a revisar todo si el cambio salió de lo revisado. Hay dos rondas de corrección como máximo: en el tope, el arnés se detiene y te lo reporta.
- **El typecheck tras cada edición** solo corre si el manifiesto declara `commands.typecheckFast`. Si no, espera a verify.
- **Los worktrees de `/arnes:worktree`** no copian `.env` ni enlazan `node_modules`.
- **La medición.** El costo por etapa lo anota `arnes-ui`: sin el mod, la timeline trae solo tiempos. Una etapa que empezó antes de que el mod cargara no lleva costo, y el costo de un agente incluye lo que gastaron los que corrieron al mismo tiempo. La espera de la persona va desde que el turno cerró hasta tu siguiente mensaje: si escribes mientras un agente trabaja en segundo plano, ese rato cuenta como espera.
- **Avisos de `arnes-ui`.** En algunas terminales los toasts no se ven, como en la de Muxentra dentro de VS Code. Los avisos importantes salen también en el transcript. Falta confirmar en una sesión real la corrección de la línea `Plan:` del panel.
- **Los mods** solo cargan en sesiones locales, y `arnes-ui` se ve solo en la terminal: no en el chat de la extensión de VS Code ni en el de Claude Desktop.
- **Instalado desde una rama,** `/arnes:init --check` da FALTA en la comprobación 6, que pide el plugin fijado a un tag `vX.Y.Z`. Es lo esperado mientras se prueba la rama.

## 7. Reportar un problema

Abre un issue en https://gitlab.com/preupdv/apps/agentic-harness/-/issues con:
- **Qué pasó:** qué pediste, qué esperabas y el texto exacto que viste, más la salida de `claude --version` y de `claude plugin list`.
- **La timeline:** la salida de `/arnes:timeline`, o el archivo `.tmp/harness/timeline.jsonl`.
- **El lock de sesión:** los archivos de `.tmp/harness/sessions/`.
- **La salida del gate:** el bloque de ci-gate del reporte de verify, o la salida de correrlo tú desde la raíz del proyecto: `node "C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/0.5.3/scripts/ci-gate.js" --ws <workspace> --base HEAD`. Suma la bandera `.tmp/harness/gate/<workspace>.json` si existe.
- **Si el problema es de plan o de review:** `.tmp/harness/plan.md` y la carpeta `.tmp/harness/review/`.

`.tmp/harness/` está en la raíz del proyecto: el repo, o la carpeta en un proyecto multi-repo. Revisa lo que adjuntas: la timeline y el plan llevan texto del issue. Nunca adjuntes `.env` ni credenciales.
