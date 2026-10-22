# Probar el arnés: guía para probadores

Versión 0.6.6, desde la rama `probadores`: cada versión se publica con un push sobre esa rama, que tiene nombre fijo. Probada con Claude Code 2.1.306 y Node 24 en Windows; la 0.5.2 corrió también en Mac. El diseño está en `docs/PLAN.md`, y `docs/como-funciona.html` lo explica desde cero.

Hay dos caminos:
- **Llegas a un proyecto ya adoptado** (academico, por ejemplo): instala los plugins (§1) y corre `/arnes:setup` con la url del repo de carpeta (§2). Es el camino normal.
- **Adoptas un proyecto que todavía no tiene manifiesto:** instala los plugins y corre `/arnes:init` (§4).

## 1. Instalar

Claude Code clona con `git` sin preguntar credenciales: la de GitLab tiene que estar guardada antes (Git Credential Manager). Después, en cualquier terminal:

```
claude plugin install arnes --marketplace "https://gitlab.com/preupdv/apps/agentic-harness.git#probadores"
claude plugin install arnes-ui@agentic-harness
claude plugin install arnes-mod@agentic-harness
claude plugin list
```

El primero agrega a tu `settings.json` de usuario el marketplace `agentic-harness`, fijado a la rama, e instala `arnes`. Los otros dos instalan los mods desde ese mismo marketplace: `arnes-ui`, la interfaz, y `arnes-mod`, que necesita Claude Code 2.1.305 o más. `claude plugin list` muestra los tres con `Version: 0.6.6`.

## 2. Preparar un proyecto ya adoptado: `/arnes:setup`

El proyecto vive en un repo de carpeta: un repo chico que versiona la composición `.claude/harness.json`, el `CLAUDE.md` de la carpeta, el `.claude/settings.json` con el marketplace y los plugins, y un `.gitignore` que ignora los repos de verdad, que se clonan dentro. Abre Claude Code en la carpeta donde quieras el proyecto y corre:

```
/arnes:setup https://gitlab.com/<grupo>/<repo-de-carpeta>.git [destino]
```

Va paso por paso, diciendo cada uno, y te pregunta antes de lo que cambia algo tuyo:
1. clona el repo de carpeta, o usa la carpeta si ya tiene composición;
2. clona cada repo en la rama que declara la composición, o hace fetch si ya está. Si uno está en otra rama, te lo dice y no lo mueve sin tu sí;
3. instala las dependencias según el lockfile (`npm ci`, `pnpm install --frozen-lockfile` o `yarn install --frozen-lockfile`), con tu sí antes porque tarda;
4. copia `.env.example` a `.env` donde falte, te lista las variables vacías y te dice a qué host apunta cada conexión a base. Nunca inventa un valor: los llenas tú;
5. prueba el comando de test sobre un spec;
6. comprueba que la línea base de tests esté commiteada y, si falta, te ofrece capturarla;
7. con graphify instalado, arma el grafo de cada repo y lo junta en la carpeta. Sin él, te dice cómo instalarlo y sigue;
8. escribe el `CLAUDE.md` de la carpeta si falta y los permisos de §3 en `.claude/settings.local.json`, cada uno con tu sí;
9. cierra con `/arnes:init --check` y una lista "pendiente tuyo": los valores de `.env`, los comandos contra la base y los permisos en el mantenedor de roles.

`/arnes:setup --check <url>` solo te dice qué haría, sin tocar nada. Nunca corre un comando de `forbidden` ni escribe credenciales.

Para recibir una versión nueva no reinstalas nada: cada versión se publica con un push sobre `probadores`, y tú corres `claude plugin marketplace update agentic-harness` y después `claude plugin update arnes@agentic-harness`, `claude plugin update arnes-ui@agentic-harness` y `claude plugin update arnes-mod@agentic-harness`. Solo llega si subió `version` en `plugin.json`. Un repo de carpeta que escribió `/arnes:init` ya apunta a `probadores`. Para quitarlo todo: `claude plugin marketplace remove agentic-harness`.

Trabaja en la terminal y con opus como modelo de la sesión principal (`/model opus`): con él, las skills del arnés se cargan solas con más fiabilidad, y el plan, que es obligatorio, sale sin que lo pidas. Los devs y los test-writers van en sonnet igual, porque así los define el arnés. El mod `arnes-ui` se ve solo en la terminal: no en el chat de la extensión de VS Code ni en el de Claude Desktop. En los dos sirve la terminal integrada.

## 3. Permisos recomendados

Sin ellos el arnés funciona igual, pero pregunta en cada script. `/arnes:setup` y `/arnes:init` los arman con los comandos de tu manifiesto y, con tu sí, los escriben en `.claude/settings.local.json` del proyecto. Para tenerlos en todos tus proyectos van en `~/.claude/settings.json`, o en el de la carpeta de `CLAUDE_CONFIG_DIR`. En ese caso cambia `<usuario>` y deja solo los comandos de test de tu repo. El porqué de cada regla está en el README, en la sección "Permisos recomendados".

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

## 4. Adoptar un proyecto sin manifiesto: `/arnes:init`

Si el proyecto ya tiene manifiesto, no hace falta: es §2. init es para adoptarlo la primera vez.

1. Haz `git fetch` y comprueba que cada repo esté en la rama que trae `.claude/harness.json`. Si un repo no lo tiene, init te dice en qué rama está y qué rama remota sí lo trae; cámbiate antes de seguir.
2. Instala las dependencias del repo (`npm ci` o la que use): init no instala nada.
3. Abre Claude Code en el repo, o en la carpeta que contiene varios, y corre `/arnes:init`. Mira todo antes de preguntar: detecta el stack, los comandos y el formato de los specs, lo que le falta a un manifiesto que ya existe y lo que haría cada paso de la adopción. Escribe sin preguntar el `.gitignore` de la carpeta, y te lo dice. No te pregunta lo que puede saber solo: los nombres, la rama de cada repo (donde vive su manifiesto, nunca la rama en que estés), la dirección del marketplace (la del plugin que instalaste) ni qué provee y qué consume cada repo. Después hace una sola ronda de preguntas, cada una con su recomendación. En academico, con los dos repos ya adoptados y sin composición, se ve así:

   ```
   Miré la carpeta academico. Ya agregué al .gitignore de la carpeta /api-academico/,
   /academico-front/, /.tmp/, /.claude/settings.local.json y /graphify-out/.

   Antes de escribir lo demás, confirma esto:

   1. La composición de la carpeta, en .claude/harness.json: los dos repos en fix/adopcion-arnes,
      que es donde vive su configuración; el back provee src/**/dto/** y el front consume
      src/**/api/**; y la misma rama del issue en los dos, con feature/.
      Recomiendo: sí, porque es lo que ya declaran los repos y lo que setup le deja a quien llega.
   2. En api-academico, prohibirle al modelo los comandos que tocan una base y que todavía no lo
      están: prisma migrate dev, prisma db push y cinco más.
      Recomiendo: sí; esos los corres tú, sabiendo a qué base apunta tu .env.
   3. En api-academico, que al cerrar cada build corran npm run build y npm run acl:sync, solo si
      tu .env apunta a la base local (localhost o 127.0.0.1 en el puerto 3306).
      Recomiendo: sí, si tu base local usa el 3306; si usa otro puerto, dime cuál.
   4. Los permisos, para que no te pregunte por cada comando del arnés, en
      .claude/settings.local.json, que no se commitea.
      Recomiendo: sí.
   5. El CLAUDE.md de la carpeta: un borrador con los repos y el flujo, que completas tú.
      Recomiendo: sí; es lo que lee cada sesión al abrir la carpeta.
   6. El .claude/settings.json de la carpeta, con el marketplace del arnés en la rama probadores,
      como lo tienes instalado.
      Recomiendo: sí, así quien clone la carpeta recibe los mismos plugins.

   Responde «sí a todo», o dime los números que cambias.
   ```

   Con tu respuesta escribe todo, lo valida y cierra en pocas líneas: qué quedó escrito, lo que te toca (commitear la configuración de cada repo en su repo y subir el repo de carpeta) y cómo sigues: "escribe tu pedido en lenguaje normal; el arnés planifica, construye, verifica y revisa solo, y al final pides /arnes:ship". En una carpeta con back y front, el contract hace que ship sepa que el back va primero.
4. Lo determinista de la adopción entra en esa misma ronda: probar que la salida del test se lea (y el flag que falta, `--verbose` o `--reporters=default`), quitar los hooks del arnés anterior, los permisos de §3, el `CLAUDE.md` de la carpeta y, con el árbol limpio, la línea base de tests con los rojos que ya había anotados en `tests/known-failures.txt` con la fecha de hoy. init no commitea: la línea base y las fallas conocidas las commiteas tú, con `gates:` al inicio del asunto.
5. En una carpeta multi-repo, haz de la carpeta un repo (`git init`), commitea lo que escribió init y súbelo: ese es el repo de carpeta que los demás usan con `/arnes:setup`.
6. `/arnes:init --check` corre las ocho comprobaciones del mínimo de adopción (`docs/PLAN.md` §8). Cada una sale `ok`, `FALTA`, `MANUAL` (configuración del host git que no se ve desde local) o `NO ADOPTABLE` (un repo sin manifiesto propio, como uno PHP, que no bloquea).

## 5. Qué vas a ver

Pide el trabajo como siempre, sin comandos: "Implementa este issue: …". El modelo escribe el plan en `.tmp/harness/plan.md` y te pide aprobarlo. El plan es obligatorio: hasta que lo apruebes en un mensaje tuyo, el arnés no deja escribir código. Para un cambio mínimo, escribe tú `/arnes:plan --trivial <el pedido>`, que deja un plan de una pantalla aprobado.

¿Y la rama? La rama te la crea el arnés al aprobar el plan, desde main actualizado; tú solo cuidas de no tener cosas a medias sin commitear. Si ya estás en otra rama, el plan te pregunta si crea una nueva desde main o si construye ahí mismo, porque el pedido continúa ese trabajo. Con tu aprobación corre solo build, verify y review, sin detenerse entre etapas aunque te haga una pregunta en el camino. verify revisa primero las convenciones del manifiesto (comentarios, `as unknown as`, `console.`, TODO), y el dev las corrige antes de entregar. El commit y el push los pides tú con `/arnes:ship`.

Los comandos que tocan una base no los corre la sesión: los scripts con sync, migrate, migrar, push, deploy, seed o reset en el nombre, y las escrituras de prisma, typeorm o knex, van en `forbidden`, y el guard los niega. Córrelos tú desde tu terminal, sabiendo contra qué base apunta tu `.env`: un proxy en `127.0.0.1` puede ser QA. La excepción es la sincronización después del build (`afterBuild`), si la aceptaste en init: al cerrar cada build, el arnés corre el build y la sincronización solo si tu `.env` apunta a la base local del patrón, y te lo dice; si apunta a otro lado, no corre nada y te lo deja en "pendiente tuyo" con el host y el puerto que vio.

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

## 6. Comandos

- **Solo los invocas tú:** `/arnes:plan --trivial <pedido>`, `/arnes:setup [--check] <url> [destino]`, `/arnes:init [--check]`, `/arnes:ship [--solo-commit] [<rama>]`, `/arnes:worktree open <slug> | integrate <slug> | close <slug> | list | pending`, `/arnes:sync`, `/arnes:limpiar [<issue>]`, que borra lo que el arnés creó para los issues ya entregados, y `/arnes:cerrar <issue>`, que cierra un issue cuyo MR ya se mergeó: trae main al día y borra la rama del issue.
- **Los carga el modelo cuando corresponde:** `/arnes:plan <issue>`, `/arnes:build`, `/arnes:verify`, `/arnes:review`, `/arnes:memory decision | gotcha | recall` y `/arnes:timeline`. No hace falta invocarlos: escribe tu pedido en lenguaje normal.
- **Del mod:** `/arnes-panel` abre o cierra el panel.

## 7. Limitaciones conocidas de 0.6.6

- **REVISIÓN HUMANA OBLIGATORIA.** Si el cambio toca `riskPaths`, el arnés lo marca en el plan, en el reporte del reviewer, en ship y en el cuerpo del MR. No aprueba por nadie: esa aprobación la da una persona en GitLab.
- **Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.** El reviewer tampoco lo certifica: busca lo que está en su lista cerrada.
- **La bandera de verificación** no vence por tiempo: vale mientras el commit de base y el contenido de los archivos tocados sean los mismos, y cubre solo esos archivos. La garantía real es el CI.
- **Un hook pre-commit que reescribe archivos**, como `eslint --fix`, hace que ship se detenga con FALLA después del commit, con los archivos que cambiaron. Decides tú. Un tocado que ship dejó fuera del commit a propósito sale como nota, no como falla.
- **Errores en tiempo de ejecución.** Lo que solo se ve arrancando la app, como un error de inyección de dependencias, no lo detectan ni tsc ni jest.
- **Las rondas de review.** La primera revisa todo en opus. Las siguientes revisan todo lo que cambió desde la anterior, archivos nuevos incluidos, en sonnet, y vuelven a revisar todo en opus si el cambio toca `riskPaths` o es más grande que lo que se revisó. Hay dos rondas de corrección como máximo: en el tope, el arnés se detiene y te lo reporta.
- **El typecheck tras cada edición** solo corre si el manifiesto declara `commands.typecheckFast`. Si no, espera a verify.
- **Los worktrees** nacen con `node_modules` enlazado al del checkout principal y con sus propias copias de `.env`, con los puertos desplazados (10 el primero, 20 el segundo), y te dicen el mapa: `api 3003 → 3013, front 3000 → 3010`.
  - Para probar la app, pídelo: "inicia la app". El arnés la levanta desde el worktree con sus puertos puestos en el entorno del proceso, que ganan a cualquier `.env` (también al del principal que carga Prisma por el enlace), y te dice dónde mirar su salida. La detienes tú.
  - Si el issue regenera algo dentro de `node_modules`, como un cambio de `prisma/schema.prisma`, ábrelo con `--no-link`, que instala adentro. Borra el worktree solo con integrate o close, que quitan el enlace primero.
- **La medición.** El costo por etapa lo anota `arnes-ui`: sin el mod, la timeline trae solo tiempos. Una etapa que empezó antes de que el mod cargara no lleva costo, y el costo de un agente incluye lo que gastaron los que corrieron al mismo tiempo. La espera de la persona va desde que el turno cerró hasta tu siguiente mensaje: si escribes mientras un agente trabaja en segundo plano, ese rato cuenta como espera.
- **Avisos de `arnes-ui`.** En algunas terminales los toasts no se ven, como en la de Muxentra dentro de VS Code. Los avisos importantes salen también en el transcript. Falta confirmar en una sesión real la corrección de la línea `Plan:` del panel.
- **Los mods** solo cargan en sesiones locales, y `arnes-ui` se ve solo en la terminal: no en el chat de la extensión de VS Code ni en el de Claude Desktop.
- **Instalado desde una rama,** `/arnes:init --check` da FALTA en la comprobación 6, que pide el plugin fijado a un tag `vX.Y.Z`. Es lo esperado mientras se prueba la rama.

## 8. Preguntas frecuentes

**¿El arnés hace pull de main?** No. El pull es tuyo. Al empezar, el plan hace `git fetch` y te dice si tu rama va atrás de `origin/main`, con cuántos commits. Si estás en main, al aprobar el plan la rama del issue sale de `origin/main` actualizado, y main solo avanza si es fast-forward y no tienes cambios a medias. Si ya empezaste una rama y quieres traerle lo nuevo de main, `/arnes:sync` lo hace con un respaldo, y te deja la vuelta atrás.

**¿Cuándo se entrega?** Cuando review termina con "Listo para /arnes:ship". `/arnes:ship --solo-commit` hace un commit por repo, el back primero, y se detiene. `/arnes:ship` a secas, además, hace push y abre los MR, después de pedirte un sí explícito. Nadie entrega por ti.

**¿Por qué ship se detuvo?** ship resuelve solo lo que falta: si no está verificado, verifica; si no está revisado, revisa; si quedó un worktree del issue sin integrar, lo integra; y un `.env` o un log se quedan fuera del commit. Se detiene solo por tres razones, y te lo dice en palabras, con los pasos para destrabarlo: la verificación está en rojo (con el archivo y la línea del primer error), la revisión encontró bloqueantes (cada uno textual, con lo que lo corrige), o el cambio toca una zona de riesgo y la entrega va directo a main sin MR, y nadie la miró (con la ruta y a quién le toca). Casi siempre el primer paso es responder "corrígelo".

**¿Cuándo se crea la rama del issue?** No al abrir la sesión ni mientras se planifica: la crea el arnés al aprobar el plan, en todos los repos del plan con el mismo nombre. ship la reutiliza al entregar, y solo la crea él si nadie la creó antes.

**¿Cuándo uso un worktree, y cómo?** Siempre, para cada issue, y no tienes que hacer nada: al aprobar el plan, el arnés mueve la sesión a un worktree nuevo, desde main al día, y tus checkouts quedan como estaban, aunque tengan cambios a medias o vayan atrás. Lo dice en la pregunta de aprobación; si prefieres la rama en tu checkout, pídelo ahí.
- **En un repo solo y en una carpeta multi-repo** funciona igual. En una carpeta, el arnés trae adentro del worktree cada repo del plan, en la rama del issue (`feature/<nombre>`), con las dependencias enlazadas y los puertos corridos. También puedes abrir la sesión tú con `claude --worktree <nombre>`, o el escritorio en modo worktree.
- **Para probar la app**, "inicia la app": arranca desde el worktree, con sus puertos.
- **Al terminar**, `/arnes:ship` desde esa sesión. Al salir, Claude Code pregunta si conservar o borrar el worktree: con "remove" el arnés quita primero los enlaces y el worktree de cada repo, y las ramas del issue quedan en los repos. Si un repo tiene cambios sin commitear, no deja borrar. Ojo: si cierras la sesión y eliges borrar, Claude Code no ve los cambios sin commitear de los repos de adentro, porque están ignorados en la carpeta; commitea antes, o elige conservar.
- **`/arnes:worktree open`** queda solo para dividir un mismo issue en tareas que tocarían los mismos archivos. Nunca borres uno a mano: integrate y close quitan primero el enlace de `node_modules`.

## 9. Reportar un problema

Abre un issue en https://gitlab.com/preupdv/apps/agentic-harness/-/issues con:
- **Qué pasó:** qué pediste, qué esperabas y el texto exacto que viste, más la salida de `claude --version` y de `claude plugin list`.
- **La timeline:** la salida de `/arnes:timeline`, o el archivo `.tmp/harness/timeline.jsonl`.
- **El lock de sesión:** los archivos de `.tmp/harness/sessions/`.
- **La salida del gate:** el bloque de ci-gate del reporte de verify, o la salida de correrlo tú desde la raíz del proyecto: `node "C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/0.6.6/scripts/ci-gate.js" --ws <workspace> --base HEAD`. Suma la bandera `.tmp/harness/gate/<workspace>.json` si existe.
- **Si el problema es de plan o de review:** `.tmp/harness/plan.md` y la carpeta `.tmp/harness/review/`.

`.tmp/harness/` está en la raíz del proyecto: el repo, o la carpeta en un proyecto multi-repo. Revisa lo que adjuntas: la timeline y el plan llevan texto del issue. Nunca adjuntes `.env` ni credenciales.
