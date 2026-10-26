---
name: init
description: Genera y valida los manifiestos .claude/harness.json de un proyecto, uno por repo y la composición de la carpeta si es multi-repo, y deja lista la adopción sin preguntar; con --check comprueba el mínimo de adopción.
argument-hint: "[--check | --baseline]"
disable-model-invocation: true
---

# arnes:init

Argumentos: `$ARGUMENTS`

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`; abajo, `S`. Córrelos con `node "S/<script>"`, la ruta entre comillas, desde el directorio de la sesión, cada comando solo. Quien lee no conoce el arnés (docs/PLAN.md §2): no le nombres scripts, flags ni códigos de salida. Dile qué escribiste, en qué archivo y para qué, en frases cortas.

## Con --check

Corre `node "S/adoption-check.js"`. Di en una línea cuántas comprobaciones pasan y, por cada FALTA, qué hay que hacer para cerrarla. MANUAL (configuración del host git) y NO ADOPTABLE (un repo sin manifiesto propio, como uno PHP) no son faltas. No modifiques nada.

## Con --baseline

Solo el paso de la línea base, para cuando init no la pudo tomar porque el árbol tenía cambios: anota `start init --detail "línea base"`, corre `node "S/adopt.js" baseline <ws> --write` por cada workspace adoptable y di en una línea qué quedó. Si alguno sigue con cambios, di qué archivos estorban. Cierra con `end init --result ok` y lo que hay que commitear (con `gates:` al inicio del asunto).

## Sin argumentos

init no pregunta. Todo lo que escribe son archivos sin commitear dentro de repos git, que se revisan en el diff y se revierten con git; la protección real es que init no commitea ni hace push. Lo que antes recomendaba es la decisión, y la dice al cerrar. No uses la herramienta de preguntas ni termines el turno esperando una respuesta: hay pasos que pueden no avanzar (abajo), y ni ahí te detienes.

1. `node "S/lib/timeline.js" start init`. No anotes el fin: init queda en curso hasta que empiece un plan, así las correcciones de la persona no se toman como pedidos de código y pueden escribir la configuración.
2. `node "S/init-draft.js" --write`: la configuración de cada repo que no la tiene y la composición de la carpeta, y lo que le falta al `.gitignore` de la carpeta. Lo que existe no se toca. Cada línea `propuesto`, `prohibido`, `sin riskPaths` y `otra rama` es una decisión para el cierre. Con `otra rama` no te cambies de rama: el script ya adoptó desde cero en la actual, porque la adopción tiene que salir de main.
3. `node "S/adopt.js" all --write`, en una pasada: completa la configuración que ya existía, quita los hooks del arnés anterior y `worktree.baseRef: "head"`, escribe los permisos (en `.claude/settings.local.json`, que no se commitea), el `.worktreeinclude` de cada repo con `.env`, la sección del arnés en el `CLAUDE.md` de la carpeta (nuevo, o al final del que ya existe), el `settings.json` de la carpeta con el marketplace, la línea base de cada repo que no la tiene y después el grafo. Salir con 1 no es un error: algún paso no pudo avanzar y va al cierre. Si dice que la configuración no valida, corrígela con Edit y córrelo otra vez.
4. El detalle (cada archivo escrito, la salida de los dos pasos) va al informe: `node "S/informe.js" path init` da la ruta; escríbelo ahí con Write.

### Lo que no puede avanzar

Init hace todo lo demás y deja cada uno en el cierre, con lo que lo resuelve:
- **La línea base de un repo con cambios sin commitear** en código: los archivos que estorban, y que cuando los commitee o los guarde, `/arnes:init --baseline` corre solo ese paso.
- **graphify sin instalar**: `uv tool install graphify`, y después `/arnes:init` otra vez, que con lo demás ya escrito solo arma el grafo.
- **Un runner que el arnés no sabe leer** (dice que no hay adaptador de resultados, como con Karma): el repo necesita en su configuración un comando propio que entregue los resultados de cada test, `commands.testJson`; para Karma, el adaptador de la guía de probadores (`docs/PROBADORES.md` §4, punto 7). Lo escribe la persona en su repo; tú no.
- **Una dependencia que falta** para correr los tests, como `node_modules`: el comando que la instala. init no instala.

Si encuentras otra cosa que de verdad no puedes decidir solo, tampoco preguntes: hazlo todo menos eso y dilo en el cierre.

### El cierre

Un solo mensaje, corto:
1. Una línea con lo que quedó escrito y dónde.
2. Lo que decidiste sin preguntar, una línea cada cosa con su porqué en una frase: las rutas que exigen revisión humana y de dónde salieron (o que no hubo ninguna en un repo), lo que se le prohíbe al modelo, el contract y la misma rama del issue en todos los repos, la sincronización después del build si la hay, los hooks que quitaste, la línea base con sus rojos conocidos (anotados con la fecha de hoy), el grafo y cuánto tardó, y la rama remota que trae configuración, con su nombre, si la hubo.
3. Lo que le toca a la persona: primero lo que no pudo avanzar, con su comando exacto; después commitear la configuración de cada repo en ese repo y la línea base con `gates:` al inicio del asunto; si la carpeta no es un repo, `git init` y subirla, y con eso otra persona la prepara con `/arnes:setup <url>`.
4. La ruta del informe.
5. "Para trabajar, escribe tu pedido en lenguaje normal; el arnés planifica, construye, verifica y revisa solo, y al final pides /arnes:ship." Nunca sugieras invocar plan, build, verify ni review a mano. Si informe.js dijo `frase: dila`, "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio."
6. Termina con: "Si algo no te sirve, dímelo en un mensaje y lo corrijo en el archivo; no hace falta repetir init."

Una corrección que llegue después se aplica con Edit sobre su archivo (la configuración de un repo o de la carpeta, el `CLAUDE.md`, el `settings.json`), y dices en una línea qué cambió. No repitas init ni sus pasos.

Un repo con solo `composer.json` (PHP), o sin typecheck ni test detectables, entra en la composición sin manifiesto propio, y eso no es un error.
