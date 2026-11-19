# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versionado semver: un tag `vX.Y.Z` cubre `arnes`, `arnes-ui` y `arnes-mod`.

## [0.8.6] - 2026-11-19

Sin trabas. Sale de revisar ocho sesiones con la 0.8.4 y la 0.8.5 en renova365 y academico, del 2026-11-09 al 2026-11-18. En cuatro de ellas el arnés se apagó entero: `api/.claude/harness.json` trae en main un campo que el arnés no conoce, el validador daba por inválido el manifiesto completo, y en cada worktree nuevo ninguna etapa corría (12 veces, con Claude aprobando planes a mano y verificando por fuera). En academico el Stop frenó 21 veces el cierre del turno mientras la persona iteraba un diseño, 16 de ellas pidiendo repetir una suite de 30 minutos que estaba en rojo por pruebas que ya fallaban, y la persona tuvo que aprobar que el `harness.json` de dos repos se copiara al worktree. En las ocho hubo 272 inyecciones de contexto en 327 mensajes. Probada en local con Claude Code 2.1.328 (el CI sigue en la 2.1.316 de `compat.json`) y Node 24, con `node --test` y `claude plugin validate --strict`; con la 2.1.328, `validate --strict` de `arnes-ui` avisa de un tipo del host que su test no declara, y pasa con la 2.1.316 del CI. `plugins/arnes/scripts` pasa de 14.144 a 14.430 líneas.

### Cambiado
- Un campo que el arnés no conoce no invalida el manifiesto: se ignora, lo demás corre igual, y SessionStart y `manifest.js validate` lo nombran en una línea con el repo y el campo. Un tipo mal puesto o un JSON ilegible siguen siendo inválidos, y los archivos que escribe el propio arnés se siguen validando estrictos.
- El código sin verificar no frena el cierre del turno. El Stop lo avisa una vez por estado, con lo que falló si la última verificación de ese contenido quedó en rojo, y la verificación la exige la entrega: el commit se niega sin bandera vigente y ship no entrega en rojo. El Stop sigue frenando por código escrito sin plan aprobado, por la configuración cambiada sin aprobación, por worktrees del issue sin integrar y por un plan aprobado sin construir.
- Build y verify dicen que un ajuste de la persona no se verifica después de cada retoque: se verifica cuando lo da por bueno, o lo pide, y siempre antes de entregar. Verify no persigue una falla que ya estaba sin el cambio.
- La configuración del arnés viaja sola (`lib/config-propia.js`). El `.claude/harness.json` que el checkout principal tiene sin commitear (sin versionar, ignorado o con un ajuste) llega al worktree al arrancar, al entrar y antes de verificar, también a cada repo de una carpeta. Lo que cambia en un worktree con init, setup o un ajuste aprobado vuelve al checkout principal al cerrar el turno: el worktree siguiente nace con él.
- El manifiesto del arnés deja de ser un archivo tocado: no entra a la cuenta, no hace verificar ni nombrar en ship un repo que solo lo tiene sin commitear, y no impide borrar un worktree (la copia se va antes, o vuelve a como la trae su rama). La bandera lleva aparte la huella de la configuración: verde con unas reglas no es verde con otras.
- `/arnes:cerrar` son dos comandos. `issues.js cerrar` mira todo de una vez: consulta los MR, dice qué cerraría o borraría de cada issue y nombra lo desconocido. `issues.js cerrar --write` lo hace: recupera los rescates, cierra lo mergeado y borra lo que sobra. Antes eran `list`, un `close` y un `clean` por issue y `unknown`, y después `recover`, `close` y `clean` uno por uno.
- El estado que se adjunta a cada mensaje (tocados, bandera, «carga arnes:plan») se dice una vez por estado y por sesión, como los avisos del Stop.
- La propuesta de un cambio de configuración se le dice a la persona en una o dos frases, sin mostrarle el bloque tal cual, y el motivo con que el guard niega escribirla avisa que copiarla a un worktree no hace falta.

### Corregido
- Con el manifiesto inválido la sesión no queda sin salida: cada etapa dice cómo proponer el arreglo, `ajuste.js` corre igual, y UserPromptSubmit anota la respuesta de la persona para que su «sí» abra la configuración.

### Pendiente, visto en la misma revisión
- La suite de un repo cuyo comando no filtra por spec (los 30 minutos de api-informes) sigue corriendo entera en cada verify, y sin un adaptador de resultados el gate no separa las fallas que ya estaban de las nuevas: con una sola prueba rota de antes, ese repo no llega a verde y no se entrega por el arnés.
- Cambiar las reglas sigue pidiendo propuesta y aprobación; lo que dejó de pedirlas es mover la configuración entre el checkout principal y los worktrees.
- El freno del Stop por código sin verificar se quitó en todos los proyectos: no hay un campo del manifiesto para volver a pedirlo en uno.

## [0.8.5] - 2026-11-12

Ejemplos y gate. Sale de revisar seis sesiones con la 0.8.4 en academico y renova365, del 2026-11-09 al 2026-11-12, leyendo también el código que produjeron. El arnés frenaba y planificaba bien, pero el código salió con defectos que ni verify ni la revisión vieron: cumplía cada criterio en el papel y fallaba con el dato real (un buscador que no encuentra el NIT con su dígito, como lo muestra la pantalla), y llegó a main un SQL que nadie había ejecutado. Del lado de las trabas, un worktree corrió tres veces una suite de 30 minutos que la persona había bajado en el checkout cinco minutos antes. Probada en local con Claude Code 2.1.322 (el CI sigue en la 2.1.316 de `compat.json`) y Node 24, con `node --test` y `claude plugin validate --strict`. `plugins/arnes/scripts` pasa de 14.004 a 14.144 líneas.

### Agregado
- Los ejemplos del plan. `## Ejemplos` lleva E1, E2…: el criterio que prueba, el dato real tal como lo ve quien usa la pantalla y lo que tiene que salir; o `sin ejemplos: <por qué>`. `plan-state.js finish-draft` no cierra el plan sin ellos, y la persona los ve al aprobar. El plan corto del carril no los pide.
- Verify, en verde, corre cada ejemplo por el camino real (la app levantada, una prueba de integración o la consulta en solo lectura contra la base local) y lo anota en `.tmp/harness/evidencia.md` como `comprobado` o `sin comprobar`, con el porqué. Un test con mocks de lo que se prueba no cuenta.
- `ship.js` cruza los ejemplos con esa evidencia: el que nadie corrió, o que se corrió antes de la última verificación, sale como `aviso:` en la pregunta del push y como `SIN COMPROBAR` en el cuerpo del MR. No frena la entrega: lo decide la persona con el dato a la vista.

### Cambiado
- El reviewer marca un criterio como cumplido solo si siguió el caso por el código, y sigue cada ejemplo con su dato tal como está escrito. Busca siempre dos posibles defectos de lógica: un dato que llega del cliente y el servidor toma como verdad para crear o aprobar algo, y un test nuevo que seguiría pasando sin el cambio.
- En una ronda acotada, si el diff cambia la regla que originó un bloqueante, el bloqueante sigue. La skill review dice que un bloqueante se corrige en el código, y que cambiar la regla pide que la respuesta de la persona nombre esa opción.
- El dev escribe y edita solo con Write y Edit, nunca por el shell, y sigue los ejemplos por su código antes de entregar. El test-writer afirma lo que el código devuelve, guarda o consulta, no lo que devuelve su propio mock.
- Un pedido distinto (otra pantalla, otro repo, otro tema) no es un ajuste del plan aprobado, aunque sea chico: es un plan nuevo. Lo dicen build y verify.
- `start --en-checkout` nunca por cuenta del modelo, y el mensaje del plan lo dice en su primera línea.

### Corregido
- En un worktree, verify toma primero el manifiesto del checkout principal cuando allá tiene un cambio sin commitear y aquí nadie lo tocó: un ajuste de configuración aprobado después de crear el worktree no llegaba. Lo dice en una línea, y no cuenta como configuración cambiada por el turno.
- Specs elegidos y ningún test corrido es rojo. En el worktree de un repo con jest, el corredor no encontraba los specs porque la ruta lleva `.claude`, y el gate daba verde con 0 de 0.

### Pendiente, visto en la misma revisión
- La revisión de un cambio grande sigue siendo una sola pasada; partirla por repo queda para otra versión.
- Las pruebas lentas de un repo (las de integración de api-informes) no tienen un lugar propio al entregar: hoy corren en cada verify o no corren.
- La verificación de un merge cuenta como del cambio las convenciones que trae la otra rama.

## [0.8.4] - 2026-11-05

Sale de dos sesiones de academico del mismo día con la 0.8.3, las dos en el checkout por pedido de la persona, sobre informes-front y api-informes, que no tienen remoto. Probada en local con Claude Code 2.1.318 (el CI sigue en la 2.1.316 de `compat.json`) y Node 24, con `node --test`, `claude plugin test` de los dos mods y `claude plugin validate --strict`. `plugins/arnes/scripts` pasa de 13.973 a 14.004 líneas.

### Corregido
- Un repo sin remoto que está en otra rama se queda en ella: `issue-branch.js check` ya no recomienda crear la rama del issue desde un `main` local que va atrás, y `create` no la mueve, tampoco con `--desde-otra`. Lo mismo que ya hacía el worktree de un repo sin remoto. El registro del issue no anota esa rama, que es de la persona.
- Sin `specPattern`, verify no arma la lista de código sin spec, que era todo lo tocado con los propios tests (api-informes, Maven); lo dice en una línea.
- `start` no avisa del plan anterior cuando ese plan ya se entregó; el aviso queda para uno sin entregar.
- El frontmatter de `arnes:worktree` vuelve a ser YAML válido: la 0.8.3 lo dejó con «: » sin comillas, y Claude Code cargaba la skill sin descripción ni `disable-model-invocation`. El test de skills falla con un valor así.

## [0.8.3] - 2026-11-05

Worktree aislado: la raíz es la puerta y el worktree es la casa. Sale de ocho sesiones de renova365 que corrieron a la vez el 2026-11-04 con la 0.8.2 y de una de academico el 2026-11-05. Los arreglos de ruido de la 0.8.2 funcionaron; quedaron dos frentes. En los gates, que son el único control de calidad cuando casi nadie lee el código, había un falso verde y bloqueos injustos. En el aislamiento, lo que hacía una sesión se escapaba del worktree o lo heredaba otra. El criterio de la persona: los worktrees sueltos, las sesiones olvidadas y la configuración imperfecta del proyecto son el flujo natural, y el arnés convive con eso. Probada en local con Claude Code 2.1.318 (el CI sigue en la 2.1.316 de `compat.json`) y Node 24, con `node --test`, `claude plugin test` de los dos mods y `claude plugin validate --strict`. `plugins/arnes/scripts` pasa de 13.939 a 13.973 líneas.

### Cambiado
- La raíz es la puerta. `plan-state.js start` y `trivial`, corridos desde la raíz, salen con 3 sin anotar nada y mandan a EnterWorktree con un nombre libre (`<n>-2` si la carpeta o la rama de una sesión olvidada ya existen), con `cd` a la raíz si la sesión está parada en un repo de adentro. Un pedido nuevo ya no reemplaza el plan aprobado y sin entregar de otro, y una sesión nueva no hereda el de una olvidada. En el checkout solo con `start --en-checkout`, sin camino de worktree, o para re-planificar con un ajuste el plan propio; `--en-checkout` ya no va en approve ni en corto.
- Al entrar al worktree no se trae nada del principal: se van el traslado del plan (la nota `movido` se sigue leyendo en las timelines viejas) y la vuelta de la timeline del worktree a la raíz al borrarlo. El estado del issue queda en el ledger. Sin plan, el worktree de una carpeta trae todos los repos, y un repo sin remoto nace de la rama del checkout, donde está el trabajo local, no del `main` que va atrás.
- SessionStart no recuerda lo que dejaron otras sesiones: ni worktrees sin integrar o sin subir, ni rescates, ni issues abiertos o entregados, ni otras sesiones abiertas. Dentro de un worktree dice en una línea el estado de su issue. `pending`, `issues.js merged` y `/arnes:cerrar` siguen listando todo.
- Dentro de un worktree que ya entregó un issue, `start` sugiere en una línea una sesión nueva: el contexto acumulado es lo que más cuesta.

### Agregado
- `build.js app` con una base que no es local en el `.env` (host y puerto, nunca credenciales) frena y pide el sí de la persona; con su respuesta la levanta y no vuelve a preguntar en el plan.
- El puerto de `ng serve` (de `angular.json`, o 4200) entra al corrimiento de puertos del worktree: `build.js app` le pasa `--port`, y un `localhost:4200` en el `.env` de otro workspace pasa al puerto nuevo. Un archivo versionado que fija el puerto de otra app no se reescribe: se avisa.

### Corregido
- `conventions.js` resuelve las rutas también contra la carpeta desde donde se corre, y una ruta que no está en el workspace sale con 2. Antes la saltaba y daba «sin hallazgos»: el test-writer corría desde la raíz de una carpeta con rutas `api/...` y verify encontraba después los `as unknown as`. La línea del input dice que las convenciones mandan sobre los ejemplos de las reglas del proyecto.
- `.mcp.json` es un secreto por nombre, en Read y en Bash: la negativa trae su JSON con `env`, `headers`, las claves sensibles y las URL enmascarados.
- Un verify vivo en segundo plano cuenta como trabajo en marcha: el Stop avisa en una línea en vez de bloquear por código sin verificar.
- Un slash command no aprueba el plan ni un ajuste: prompt-context lo marca en la respuesta.
- La ronda acotada de la revisión no arrastra los posibles defectos de lógica que la corrección resolvió; el reviewer repite los que siguen.
- `ship.js deliver --commit` anota el commit de cada workspace: correrlo otra vez no lo repite ni lo toma por un HEAD movido.
- El grafo de `start` consulta solo si el pedido nombra una clase, un archivo o una ruta, y deja los nodos que la nombran. Las referencias de MR de un issue en varios repos llevan el repo.
- El `git init` que hace repo de carpeta la raíz ya no cuenta como configuración cambiada en el Stop de otra sesión.
- El test-writer corre también el `lint` de su entrada sobre sus specs, y corrige a mano el formato y los imports sin usar antes de entregar.
- `trivial` toma de la raíz solo el `/arnes:plan --trivial` de su propia sesión: la nota de respuesta lleva la sesión.

## [0.8.2] - 2026-11-03

Ronda correctiva con lo que se vio usando la 0.8.1 el 2026-11-03 en renova365 y academico. Una sesión sin código recibía el estado y los avisos de otra. El grafo se disparaba con palabras comunes. El Stop pedía construir con la rama a medias. Un ajuste después de verify reabría el plan. En una carpeta sin repo se ofrecían caminos que fallan. La banda arrastraba el gate del checkout al worktree. El motivo de `.ssh` no decía lo que protege. El test-writer volvía por convenciones. Sin funciones, subcomandos ni flags nuevos. Probada en local con Claude Code 2.1.317 (el CI sigue en la 2.1.316 de `compat.json`) y Node 24, con `node --test`, `claude plugin test` de los dos mods y `claude plugin validate --strict`.

### Corregido
- Con otra sesión viva dueña del plan en curso (`lib/sesiones.js planOwner`), el Stop de esta sesión no juzga el código sin verificar, los worktrees sin integrar ni el plan sin construir, y no avisa del trabajo en marcha ni de la revisión que falta: todo eso es de la dueña. plan-guard le niega escribir código bajo ese plan. Los agentes de la dueña llevan su sesión y escriben.
- En esa sesión, prompt-context no adjunta las líneas de estado de cada workspace: queda solo el aviso de planificar en su propio worktree.
- Una pregunta suelta consulta el grafo solo si trae un término con forma de código: camelCase, PascalCase de dos palabras o más, snake_case, una ruta o un archivo. Ya no basta con «cuatro palabras». De los nodos quedan los que nombran ese término, y si no queda ninguno no inyecta nada.
- El Stop (e) no pide construir si approve no dejó la rama del issue en todos los workspaces del plan. La nota `rama` de plan lleva `faltan`, y `issue-branch.js create` la anota aunque la rama no quede en ninguno.
- «Si pide cambios», en la skill plan, es antes de aprobar. build y verify dicen qué hacer con el plan ya aprobado: un ajuste en los mismos workspaces, sin riskPaths y sin cambiar el contrato ni los datos, se anota en `## Decisiones` como ajuste de la persona, se corrige y se verifica, sin `plan-state.js start`.
- En una carpeta que no es repo, `plan-state.js start` con el plan de otra sesión no sugiere EnterWorktree ni `claude --worktree`, que fallan ahí: dice cómo hacerla repo de carpeta. `issue-branch.js create`, cuando se niega por cambios sin commitear en otra rama, ofrece eso primero y después commit o stash.
- arnes-ui reinicia las filas del gate al entrar o salir de un worktree.
- La negativa sobre `.ssh` o una llave dice que ahí están las llaves y el acceso a servidores, en vez de «los secretos no entran al transcript». La regla no cambia.
- El test-writer corre sobre sus specs las convenciones del gate (la línea de su entrada, el mismo chequeo de verify) hasta que salgan limpias, antes de entregar.

## [0.8.1] - 2026-10-31

El lint tras cada edición con tope (`docs/PLAN.md` §6.2). Medido en renova365/api: un eslint con reglas type-checked (`recommendedTypeChecked` con `projectService`, la configuración por defecto de NestJS) tarda 163 s y 180 s en lintear un solo archivo, porque compila el monorepo entero en cada corrida, y el hook after-edit tiene 120 s: cada Edit o Write colgaba dos minutos y el resultado nunca llegaba. Los hooks en sí cuestan poco en ese repo: 72 ms read-guard, 113 ms guard y 258 ms plan-guard por llamada. Probada con Claude Code 2.1.316 y Node 24 con `claude plugin validate --strict` y `node --test`.

### Agregado
- `lib/exec.js runTimed` y `runTimedExpanded`: un comando con tope de tiempo que al vencer mata el árbol de procesos entero (`taskkill /T` en Windows, el grupo de procesos en el resto), no solo el shell.
- init avisa «lint lento» cuando la configuración de eslint del repo tiene reglas type-checked (`projectService`, `parserOptions.project`, `recommendedTypeChecked`…).

### Cambiado
- after-edit corre el lint del archivo editado con un tope de 30 s. Al vencer lo corta, dice una vez que el lint de ese repo queda para la verificación, y en ese workspace no vuelve a intentarlo durante 10 minutos (`.tmp/harness/after-edit/<ws>.lint-lento.json`). `ARNES_LINT_TIMEOUT_MS` acorta el tope en los tests.
- `lib/hook.js run` acepta un hook que devuelve una promesa.

## [0.8.0] - 2026-10-31

Flujo liviano (`docs/PLAN.md` §6.2, ronda de flujo liviano): menos paradas, con la misma calidad. Por los datos de uso real del 26 al 31 de octubre: en renova365, unos diez mensajes de la persona por issue y más espera de la persona que trabajo del agente; en academico, una revisión que se llevaba un tercio del costo con bloqueantes casi todos de patrón. Rama `feature/flujo-liviano`, desde la 0.7.5, probada con Claude Code 2.1.316 y Node 24 con `claude plugin validate --strict`, `node --test` (512 tests) y `claude plugin test` de los dos mods.

### Agregado
- El carril corto: un pedido de un workspace, cinco archivos o menos, sin riskPaths, sin contrato, sin migración y sin preguntas lleva un plan corto que `plan-state.js corto` aprueba por reglas, sin esperar a la persona, y que build construye en el hilo principal, sin el agente dev. Ship avisa en la pregunta del push si el cambio real salió del carril.
- El plan es de la sesión que lo empezó (`lib/sesiones.js`): con el plan de otra sesión viva, `start` no lo pisa y manda a planificar en un worktree propio; EnterWorktree solo se lleva el plan propio, y el prompt de la otra sesión trae el aviso.
- `worktree-carpeta.js equipar`: los `.env` que le faltan a cualquier worktree, nativo o no, copiados del checkout principal sin mostrar sus valores, con `node_modules` y puertos. «Levanta la app» lo corre si falta el `.env`, y SessionStart copia los que `.worktreeinclude` no trajo.
- Un spec renombrado no es uno borrado (`lib/renombres.js`): se compara con los números del viejo, y verify pasa la base al nombre nuevo antes de la bandera (`test-baseline.js renombra`). Las convenciones no marcan lo que un archivo renombrado ya traía.
- Los posibles defectos de lógica del reviewer van en su propia sección, y ship los muestra en la pregunta del push y en el MR, sin bloquear.
- Las desviaciones del dev van a `## Decisiones` del plan con la marca `(del dev, sin confirmar)`; el reviewer las juzga como decisiones y ship las pone en la pregunta del push y en el MR.
- De la revisión al chequeo: el reviewer propone la `CONVENCIÓN` de cada bloqueante de patrón, `review.js` la prueba sobre todo el repo (`conventions.js probar`) y ship la ofrece con el mismo «corrígelo» («corrígelo sin reglas» la deja fuera).
- `verify.js run --integracion`: la entrada del test-writer para las pruebas de integración que pide el plan.
- `plugins/arnes/compat.json`, la versión de Claude Code con que se probó el arnés, en una sola fuente: la instala el CI, `tests/compat.test.js` exige que la última fila de la matriz del README y `docs/PROBADORES.md` digan la misma y que los tres `plugin.json` lleven la misma `version` con su entrada aquí, y SessionStart avisa en una línea si la sesión corre una versión más nueva (`lib/compat.js`: la lee de `AI_AGENT` o del `package.json` junto a `CLAUDE_CODE_EXECPATH`, sin lanzar ningún proceso).
- La lista de las piezas que compensan al modelo, en el README, cada una con lo que se observa en el piloto para retirarla; y en `docs/PROBADORES.md` §10, qué medir por issue (respuestas, espera, costo, carril y cada freno) para decidirlo. Es el principio 1 con un procedimiento.

### Cambiado
- El aviso del Stop que no bloquea se dice una vez por estado y por sesión.
- El grafo solo se consulta con una pregunta sobre el código: no con «¿sí?», ni con palabras del arnés o de la sesión, ni con una etapa abierta.
- verify no repite un workspace verde con el mismo contenido, y para a la tercera vuelta en rojo desde el último mensaje de la persona (`tope:`); el Stop deja de pedir otra.
- El test-writer recibe el comando de convenciones y corre el typecheck y las convenciones sobre sus specs antes de entregar.
- El `.env` enmascarado muestra el host, el puerto, la base y el ambiente, nunca usuarios, claves, llaves ni tokens.
- La entrada del reviewer lleva primero las cabeceras de todos los workspaces y después los diffs, cada uno con su parte del tope.
- El estado del README en diez líneas, con la historia en este changelog; `docs/PROBADORES.md` al día con la 0.8.0.

### Corregido
- Ship metía en la entrega un repo con solo configuración o archivos del arnés sin commitear, y el stage fallaba.
- El commit de un workspace vencía la bandera y la revisión de otro del mismo repo.
- La salida generada sin trackear (`dist`, `.astro`, `coverage`…) contaba como código tocado.
- Un base sin el workspace hacía fallar el typecheck por `git archive`.
- El CI fijaba Claude Code 2.1.310 mientras el README decía 2.1.316: ahora los dos leen `compat.json`.

## [0.7.5] - 2026-10-27

El arnés frena donde no debe (`docs/PLAN.md` §6.1, §6.2, §6.3, §6.5 y §8): seis trabas vistas en uso real. Rama `feature/menos-trabas`, desde el tag `v0.7.4`, probada con Claude Code 2.1.311 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, con la corrida A y con una corrida aparte sobre un repo con lint acotado, una propuesta de configuración y una pregunta con grafo (§10). La corrida A costó US$3,38 (US$3,46 con la 0.7.4).

### Agregado
- `lintGlobs`, el alcance del lint del repo: `init-draft` lo saca del script `lint` del `package.json` o del `include` del `tsconfig.json`, y `adopt.js complete` lo agrega a un manifiesto con lint sin acotar. El gate y el hook de edición lintean solo lo que cae ahí; un tocado fuera sale en una línea, «fuera del alcance de lint del repo», y no es falla.
- Un «sí» de la persona a un cambio de configuración vale como `/arnes:init --ajustar`: el modelo lo propone por escrito con `ajuste.js propone`, y con la respuesta de la persona desde el composer (origen y hash, sin marcas) `ajuste.js aprueba` abre la configuración solo ese turno. El Stop la cierra y anota qué cambió. Un agente, bridge, sdk o una respuesta sin propuesta no abren nada. Los motivos de negación de plan-guard y del guard dicen cómo proponerlo.
- Las preguntas consultan el grafo: el hook del prompt, o arnes-mod en su camino de pregunta, mete los nodos que `graphify query` encuentra para el texto, con archivo y línea, con el mismo tope y presupuesto que `plan-state start` (`lib/grafo.js`).
- El Stop frena una vez el turno que aprueba el plan y no empieza build, y su motivo dice que siga con build.

### Corregido
- El guard negaba `ajuste.js propone` porque el comando nombra la configuración; lo encontró la corrida con `claude -p`. `ajuste.js` no la escribe.

### Cambiado
- El cierre de un turno bloqueado dice el paso que sigue: «corre la verificación», o «corrige esto y verifica» con lo primero que falló en la última corrida del gate, y si la falla es de configuración, qué cambiar y que se aprueba respondiendo que sí.
- La skill verify corrige en rojo y vuelve a verificar sin pedir permiso.
- La coma o la comilla que falta en un `settings.json` la arregla `adopt.js`, con una copia `.bak`, y sigue con el paso; la skill ya no edita ese archivo, por el que Claude Code pide permiso también en modo interactivo.
- La consulta al grafo de `start` tiene un tope de 12 s por consulta (antes 120 s), el mismo que el de las preguntas; el timeout de UserPromptSubmit pasa a 35 s.

## [0.7.4] - 2026-10-27

Lo que init decide solo y lo que el flujo hace sin que nadie lo vigile (`docs/PLAN.md` §6.1 a §6.5b y §8), por la primera adopción real con init sin preguntas: una carpeta con un api NestJS y un client Angular 21 con Karma. Rama `feature/init-decide-solo`, desde el tag `v0.7.3`, probada con Claude Code 2.1.311 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, con `/arnes:init` en `claude -p` sobre una carpeta de prueba con esos casos, y con la corrida A antes y después (§10): en un issue de una sola vuelta de build el total queda igual, US$3,49 con la 0.7.3 y US$3,46 con la 0.7.4, porque la revisión se paga una vez en las dos; la 0.7.4 la paga en ship (US$0,42 la ronda), y cada vuelta de build de más ya no paga otra. El plan de la 0.7.4 arrancó con los nodos que consultó `start`, y el dev y el test-writer corrieron en sonnet con el orquestador en opus.

### Agregado
- `adopt.js all --write` deja su PID en `.tmp/harness/adopcion.json` mientras vive, y el Stop no cierra un init o setup abierto mientras ese proceso exista: lo dice, y lo cierra el primer Stop después de que termina. La skill corre la pasada en primer plano con el tope de la herramienta.
- Cada paso de la adopción (manifiestos, hooks, permisos, worktreeinclude, la línea base de cada workspace y el grafo de cada repo) queda en la timeline mientras corre, con lo que tardó; arnes-ui lo pinta en la banda y en la cronología («Adoptando (línea base de client) 03:12»), y el cierre de init trae los tiempos por paso.
- `plan-state.js start` consulta el grafo él mismo con el texto del pedido, en la carpeta y en cada repo que lo tiene, en paralelo, y devuelve los nodos con su archivo y su línea; esas consultas cuentan como las del modelo, y el panel deja de decir «sin consultar».
- `plan-state.js caminos "<texto>"`: cada lugar del código que produce un mensaje de la pantalla, literal o por su constante. Un pedido que reemplaza un mensaje, un error o una pantalla se planifica por caminos: cada uno va a los criterios con su `archivo:línea` y a la prueba manual, y el plan dice si encontró uno solo.
- arnes-mod niega el lanzamiento de un agente `arnes:*` que llega con `model` o `effort` distintos a los de su definición, con un motivo que pide relanzarlo sin esos campos, salvo que la persona lo haya pedido en su mensaje o sea el reviewer en sonnet en una ronda acotada (`lib/agentes.js`). build y verify ya no los pasan.
- La línea base que no compila guarda la cuenta entera (`$defs.testRun.cuenta`): cuántos errores, en cuántos archivos y los archivos de más a menos, por el `tsc` del workspace sobre el tsconfig de specs; el cierre de init la dice así, con los primeros errores como muestra.

### Cambiado
- El contrato sale de contar las carpetas: un back provee las `dto` o `contracts` bajo `presentation`, un front consume las `interfaces` o `types`, gana el nombre con más carpetas y la nota dice las cuentas. Una sección de contrato del `CLAUDE.md` del repo manda. Sin señal no se escribe, y se dice.
- riskPaths por palabra completa y en cuatro categorías que el cierre nombra (autenticación; roles y permisos de sistema; migraciones y herramientas de migración; aprobaciones de dinero, autorización y aprobador), sin docs ni `.md`, sin SST, ausencias ni nómina, sin roles de un dominio, y diciendo cuántas rutas descartó y por qué.
- Lo prohibido sale de los scripts del `package.json`, como se teclean con el gestor del repo: los que corren migraciones (`migration:run`), sincronizan o borran el esquema, consultan la base o reescriben archivos.
- La revisión se paga una vez, en ship: build termina en verify, ship revisa el diff completo antes de commitear, y si la repite por cambios posteriores revisa solo el diff desde la última ronda (la ronda acotada ya no escala a completa por tamaño, solo por riskPaths). La persona puede pedirla antes con `/arnes:review`.
- El cierre de init escribe cada glob, ruta y comando entre comillas de código.
- La skill plan lee el issue antes de `start`, para que la consulta al grafo lleve las palabras del pedido.

### Corregido
- Un `.claude/settings.json` o `settings.local.json` con JSON inválido cortaba la pasada de init con una traza. Ahora el paso que lo lee dice el archivo, la línea y la columna, los demás siguen, y da el comando que corre solo ese paso; la skill arregla sola una coma o una comilla que falta y repite solo ese paso.

## [0.7.3] - 2026-10-26

Karma de serie y cuatro ajustes a init sin preguntas (`docs/PLAN.md` §6.1, §6.2 y §8). Rama `feature/init-sin-preguntas`, probada con Claude Code 2.1.310 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, con Angular 21.2, `@angular-devkit/build-angular` 21.2.28, karma 6.4.4 y Chrome sin cabeza sobre el repo de prueba `tests/fixtures/angular-karma`, y con `/arnes:init` en `claude -p` sobre la carpeta de prueba contable (§10).

### Agregado
- Karma de serie: un `ng test` cuyo `angular.json` usa un builder de Karma se lee sin que la persona escriba nada en su repo. El arnés le pasa `--karma-config` con una configuración temporal (la del repo si declara `karmaConfig`, o la de serie del builder con los plugins del `node_modules` del workspace) que suma un reporter propio, `lib/karma-reporter.js`, que escribe cada test al terminar en `.tmp/harness/karma`. `{specs}` pasa a un `--include` por spec; la suite completa va sin `--include` y saca el archivo de cada test del `describe` de más arriba, sin inventar uno si está en dos specs. init escribe `npx ng test --watch=false --browsers=ChromeHeadless --include {specs}`, y probe ya no pide un adaptador.
- El gate de Karma aísla los tipos: cada corrida de los specs tocados lleva `--ts-config` con un tsconfig temporal en `.tmp/harness/karma` que extiende el de specs del target de test, compila solo esos specs y los `src/**/*.d.ts`, conserva sus `types` con jasmine y apunta `typeRoots` al `node_modules/@types` del workspace. Con `--include` solo, un spec roto que nadie tocó tumbaba la corrida: con el builder de devkit en webpack, el plugin de Angular revisa los tipos de todo el tsconfig, como se vio en el client de renova con un TS7006. La línea base completa sigue con el tsconfig del repo, y cuando queda en no-compila y los tocados corren, el gate lo dice en una línea.
- El estado de la corrida (`$defs.testRun`) en el contrato de resultados y en la línea base: completa, abortada (cuántos tests corrieron de cuántos y el último) o no-compila (los primeros errores). La línea base se toma igual con una suite que se corta o no compila, y el gate de los specs tocados sigue por `--include`; un spec tocado que la base abortada no alcanzó cuenta sus fallas, no sus saltos.
- `/arnes:init --ajustar <qué cambiar>`: la corrección de lo que escribió init, en un turno que abre init solo para eso.

### Cambiado
- init se cierra al final de su turno. Dejarlo abierto hasta el plan dejaba escribir código sin plan en esa ventana, cambiando `codeGlobs` en el manifiesto. El Stop mira si init o setup corrieron en el turno que cierra.
- init y setup se cierran solos: si siguen abiertos cuando el turno termina, el Stop les anota el fin y lo dice en una línea, así una corrección que olvidó anotarlo no deja la configuración escribible. setup vuelve a abrir su etapa en el turno de la respuesta a su ronda.
- La sección del arnés en un `CLAUDE.md` de carpeta existente se agrega siempre, sin el tope de 200 líneas.
- `/arnes:init --check`, con una rama remota que trae la configuración, dice que init va a adoptar desde cero en la rama actual y nombra la rama, en vez de «cámbiate antes de seguir».
- `docs/PROBADORES.md` deja de traer el adaptador de Karma que escribía la persona; `commands.testJson` queda para los runners que no vienen de serie.
- La rama `probadores` se retira: cada versión se publica en `main`, y la guía instala desde ahí. `adopt.js folder-settings` fija el marketplace del repo de carpeta a `main` salvo un `--ref`, aunque el plugin instalado esté en otra rama.

### Corregido
- El `remote` de un repo cuyo origen es una ruta local de Windows se guardaba `C//Users/...`; queda como ruta.

## [0.7.2] - 2026-10-26

init deja de preguntar (`docs/PLAN.md` §8). Rama `feature/init-sin-preguntas`, desde el tag `v0.7.1`, probada con Claude Code 2.1.310 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y con `/arnes:init` en `claude -p` sobre la carpeta de prueba contable (§10): de dos turnos de la persona a uno, de 65 llamadas del hilo principal a 18 y 22 en dos corridas, de 227 s del modelo a 81 y 104 s, y de US$1,20 a US$0,41 y US$0,56. Con un repo con cambios sin commitear, un turno: todo escrito menos esa línea base, que queda en el cierre con `/arnes:init --baseline`.

### Cambiado
- `/arnes:init` no hace ronda de preguntas: escribe todo en un solo turno, y lo que antes recomendaba es la decisión. Todo lo que escribe queda sin commitear, a la vista en el diff; init no commitea ni hace push. La skill corre `init-draft.js --write` y `adopt.js all --write`, la pasada de la adopción en un proceso (lo que le falta a la configuración existente, los hooks del arnés anterior, `worktree.baseRef`, los permisos, `.worktreeinclude`, el `CLAUDE.md` y el `settings.json` de la carpeta, la línea base y el grafo).
- El cierre es un solo mensaje: lo escrito y dónde, lo que decidió solo con su porqué, lo que le toca a la persona (primero lo que no pudo avanzar, con su comando) y la ruta del informe. Una corrección se pide en un mensaje y se aplica con Edit sobre el archivo, sin repetir init; para eso init queda en curso hasta que empieza un plan, que lo cierra.
- Un paso que no puede avanzar (la línea base con cambios sin commitear, graphify sin instalar, un runner sin adaptador) no detiene init: hace lo demás y lo deja en el cierre con `/arnes:init --baseline`, `uv tool install graphify` o un `commands.testJson` con el adaptador de Karma de la guía.
- `init-draft` propone `riskPaths` por el nombre de las rutas (migraciones, autenticación, permisos, roles, seguridad) y dice de dónde salen; `adopt.js complete` se las propone a un manifiesto existente que no declara ninguna.
- Si una rama remota trae la configuración que le falta a un repo, init ya no pregunta ni se cambia a ella: adopta desde cero en la rama actual y la nombra en el cierre. `adopt.js switch` se retira.
- Un `CLAUDE.md` de carpeta que ya existe recibe la sección `## Arnés` al final, sin reescribir lo demás y solo si cabe bajo las 200 líneas. Una línea base que ya existe no se vuelve a tomar en la pasada.
- `docs/PROBADORES.md`, `docs/como-funciona.html` y el README cuentan el flujo nuevo.

### Corregido
- El Stop bloqueaba el turno de init pidiendo plan por el código sin commitear que la persona ya tenía: sin configuración al empezar el turno no había foto de ese repo, y sin foto todo contaba como del turno. Con init o setup en curso, un workspace sin foto no cuenta ese código, y el Stop solo avisa.

## [0.7.1] - 2026-10-26

Huecos cerrados antes del piloto, por una revisión propia del arnés y una externa leyendo el código. Rama `feature/consolidacion-a`, probada con Claude Code 2.1.310 y Node 24 con `claude plugin validate --strict`, `node --test` y `claude plugin test` de los mods. El CI pasa a fijar 2.1.310, y el README alinea el estado y la matriz.

### Corregido
- El plan obligatorio ya no se rodea por el shell. plan-guard solo mira Edit y Write, así que un `sed -i`, un `Set-Content` o un `node -e` escribían código sin plan aprobado, y el Stop solo pedía verificarlo. Ahora el Stop bloquea el turno que cambió código de un workspace adoptable sin plan aprobado, mirando los tocados y no los comandos; una bandera de verificación vigente no lo absuelve. Cuenta archivo por archivo contra la foto del turno, que guarda el sha256 de cada archivo de código tocado: el código que la persona dejó antes no se le cobra a un turno que solo tocó otra cosa, salvo que el turno lo vuelva a cambiar. La condición de verificar del Stop cuenta igual, así que ese turno tampoco se bloquea pidiendo verificar el código de la persona: solo avisa. Los archivos borrados no cuentan (`docs/PLAN.md` §6.2).
- La configuración de un proyecto del arnés (bajo un `.claude/`: `harness.json`, `settings.json`, `settings.local.json`, `rules/` y `hooks/`; `lib/configuracion.js`) solo cambia con init o setup en curso, también con plan aprobado. plan-guard niega escribirla, también para crearla dentro de un proyecto. Por el shell solo se lee (`cat`, `jq`, `grep`, `git diff`, `git log`…); el guard niega todo lo demás que la nombre, la redirección de salida hacia ella, borrar o mover la carpeta que la tiene y el `git commit` que la lleva, staged o con `-a`. `/arnes:ship`, que commitea desde su propio proceso y el guard no ve, la deja fuera del commit, también la que ya estaba en el stage, buscada desde la raíz del repo para que en un monorepo no se escape la de la raíz, y lo dice: la commitea la persona. Su reporte del stage muestra el índice entero, que es lo que lleva el commit. El costo: si la persona pide permitir un comando, ahora edita ella `settings.json`. Un repo cuyo HEAD trae el manifiesto y el árbol no sigue contando como del arnés: sin él, `rm .claude/harness.json` apagaba todo lo demás. plan-guard no deja escribir en él, el guard niega el commit y el Stop avisa, hasta que la persona commitee el borrado. Fuera de todo proyecto del arnés no se juzga. Como red, el Stop bloquea una vez el turno que cambió un manifiesto, comparando lo que difiere de su HEAD con la foto del turno (`_configuracion` en `turn.json`); lo que llega commiteado con un checkout, un pull o un merge no cuenta.
- El guard niega, haya o no manifiesto, `git restore` (salvo solo `--staged`), `git reset --merge`, `git checkout` de rutas y `git checkout` o `git switch` forzados cuando botan cambios sin commitear de archivos trackeados, `git stash drop` y `clear` con algo en la pila, y el push que borra ramas del remoto (`--delete`, `-d`, refspec `:rama`, `--prune`, `--mirror`). Sin nada que perder, pasan: devolver un archivo borrado no pierde nada, y lo staged cuenta aunque el árbol sea igual a HEAD. `git rebase` y `git branch -f` siguen pasando: el reflog los deshace y el push que haría falta después ya es forzado.

### Cambiado
- El README ya no ofrece `/arnes:worktree open`, que se retiró en la 0.7.0.

## [0.7.0] - 2026-10-24

Ronda de consolidación: no agrega funciones; quita turnos, duplicación y huecos, y mide antes y después (`docs/PLAN.md` §6.1). Rama `feature/consolidacion-a`. En la corrida A de §7, de 83 llamadas a Bash del hilo principal a 37 y de US$4,60 a US$3,17; el plan de talleres, de 16 a 3 (§10).

### Cambiado
- Una llamada por transición: `plan-state.js start`, `finish-draft` y `approve`, `build.js input` y `end`, `verify.js run`, `review.js round` y `round --marca`, y `ship.js deliver`, `--commit` y `--push` hacen adentro lo determinista de cada etapa (la timeline, el proyecto, las ramas, el gate, las banderas, la marca de la revisión, los commits, el push y los MR) y dejan una sola salida y el informe. Al entrar con EnterWorktree, su PostToolUse trae el plan aprobado, la rama y la lista de tareas. El push exige una respuesta de la persona después del commit. Las skills usan las fachadas; los permisos no cambian.
- Una sola fuente de lógica: arnes-ui y arnes-mod dejan de resolver el manifiesto, leer la timeline, traducir globs y contar el código por su cuenta, y leen `manifest.js show --json`, `timeline.js summary --json` y `gate-flag.js status --json` del plugin base, al arrancar y cuando cambia el archivo. La cronología de la corrida pasa a `lib/timeline.js`, y la vigencia de la bandera en la banda es la exacta del guard. Un test del CI niega en los mods esa lógica.
- arnes-ui sin sondeo ciego: ya no lee `.tmp/harness` cada 3 s ni corre `git status` cada 15 s. Lanza `vigia.js`, que observa la timeline y la carpeta del gate con `fs.watch` (con un respaldo cada 60 s) y le manda una línea JSON por cambio; el gate se pide una vez más después de una edición o de un turno. El costo de cada etapa se anota con `timeline.js note --usd`, no con un `node -e`.
- Los resultados de tests se leen como un contrato estructurado (`$defs.testResultContract` del schema: archivo, nombre completo y estado de cada test, más el resumen), nunca del texto de la corrida. De serie, jest (`--json --outputFile`), vitest (`--reporter=json --outputFile.json`) y `node --test` (un reporter propio del plugin, `lib/node-test-reporter.js`); el flag lo agrega el script y los manifiestos no cambian. Para otro runner, `commands.testJson` en el manifiesto; el adaptador de Karma está en `docs/PROBADORES.md` §4. `tests/baseline.json` y `tests/known-failures.txt` no cambian.
- `adopt.js probe` ya no pide `--verbose` ni `--reporters=default`, y `probe --write` desaparece: init pregunta, en su lugar, por el adaptador de un runner que el arnés no sabe leer.
- Un solo sistema de worktrees: se retiran los sets del registro (`/arnes:worktree open`, sus ramas `wt/...` y sus puertos). Cuando dos devs del mismo build chocarían en los mismos archivos, build lanza al segundo con `isolation: worktree` y Claude Code le da su worktree; el SubagentStart lo anota en el registro del checkout que lo lanzó y le enlaza `node_modules`, y `build.js end --worktree` lo integra (foto de lo sin commitear, `merge --no-ff` en la rama del issue, worktree y rama borrados). `/arnes:worktree` queda con `integrate`, `close`, `list` y `pending`, y los registros de sets viejos se siguen integrando. Sin dependencias circulares diferidas entre `worktree-carpeta.js`, `issues.js` y el registro (`lib/puertos.js` nuevo).
- Un solo informe de sesión, `sesion-actual.md`, que cada arranque sobrescribe; los `sesion-<hora>.md` de versiones anteriores se borran al arrancar y `/arnes:cerrar` ya no los ve.

### Corregido
- El `node --test` de un repo corre sin las variables `NODE_TEST_*` heredadas, que dentro de otro `node --test` le impedían correr sus archivos.
- El guard entiende una comilla escapada dentro de comillas, con los escapes del shell que corre el comando: `\"` en bash, `` `" `` y `""` en PowerShell, `^` en un `cmd /c`. `echo "hola \" && rm -rf /"` es un solo comando y `git commit -m "fix: \"a; b\""` también; en PowerShell un `<<EOF` no es heredoc.
- Aprobar un plan exige una respuesta humana probada. arnes-mod deja en `turn.json`, antes de que corra UserPromptSubmit (comprobado en 2.1.309), el origen de cada prompt (`composer`, `bridge`, `sdk`, `task-notification`, `peer`...) con el sha256 de su texto, y `prompt-context` decide con eso; sin el mod, la expresión busca las marcas de tareas y agentes en cualquier parte del texto y, ante la duda, no es la persona. La nota `respuesta` guarda el origen, el hash y si el texto trae marcas; `plan-state.js approve` exige hash y ninguna marca, y `timeline.js` ya no escribe notas del turno.
- Un worktree de Claude Code dentro del repo sin ignorar (`.claude/worktrees`) ya no cuenta como tocado: la huella fallaba al leerlo como archivo.
- El inicio del turno que mira el Stop va en la foto (`_desde` de `turn.json`), no en la fecha del archivo, que ahora el mod reescribe con cada prompt.
- La protección de secretos por shell ya no depende de una lista de lectores: se niega cualquier comando cuyos argumentos nombren un archivo de secretos, también dentro de un argumento (`node -e`, `--env-file=.env`), con el contenido enmascarado en el motivo. `tail`, `more`, `sed`, `grep`, `Select-String` y `node -e` caen igual que `cat`. Solo pasan `ls`, `dir` y `rm` (y `Get-ChildItem` y `Remove-Item`), sin tubería ni sustitución, y escribir por redirección (`> .env`).
- arnes-mod: un mensaje con signo de interrogación al inicio o al final pasa como pregunta sin llamar a haiku, aunque traiga un verbo de cambio ("¿cómo funciona el servicio que crea facturas?"); el resto lo decide haiku.
- arnes-ui para su vigía antes de ExitWorktree: el proceso, con el cwd en el worktree y observando su `.tmp/harness`, retenía la carpeta en Windows y Claude Code no podía borrarla al salir con `remove`.

## [0.6.9] - sin etiquetar

Ronda corta de limpieza segura antes de soltar la 0.6.8 a los probadores: los huecos que dejó anotados la corrida C y los que confirmó una revisión externa leyendo el código (`docs/PLAN.md` §7). Rama `feature/limpieza-segura`, probada con Claude Code 2.1.309 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y corridas de punta a punta con `claude -p` sobre la carpeta de prueba con dos repos.

### Añadido
- `build.js app stop`, que la persona pide con "para la app": para el árbol del PID raíz que anotó `build.js app` (`taskkill /PID <pid> /T /F` en Windows, el grupo de procesos en el resto), solo si el proceso todavía lleva la marca que se le puso al lanzarlo; nunca por nombre de imagen ni un proceso ajeno (`lib/app.js`).
- La ruta exacta del worktree en el aviso al mudarse y al arrancar en uno, con `code -r "<ruta>"` si VS Code está en el PATH; la banda de arnes-ui dice `en worktree <nombre>`.
- Una línea fija en el protocolo de SessionStart: responder en el idioma del pedido de la persona, en español si no hay pedido.
- La negativa de leer un `.env` (Read, Grep, `cat`, `Get-Content`) trae su contenido enmascarado: los nombres completos y, de cada valor, su forma y a lo sumo sus tres primeros caracteres; de una URL, el host y el puerto sin usuario ni clave (`lib/env-mask.js`). `envReveal` en el workspace lista lo que se muestra entero.
- SessionStart anota en la timeline y en el informe de la sesión la superficie en que corre (`CLAUDE_CODE_ENTRYPOINT`, `TERM_PROGRAM`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_CHILD_SESSION`), y la skill plan ofrece siempre el `code -r` al mudarse a un worktree.

### Cambiado
- `issues.js clean` y `close`, el borrado de un worktree nativo, ExitWorktree y el registro de worktrees paran antes la app que levantó el arnés ahí; si no pueden, no borran.
- Recuperar el rescate de una carpeta vuelve a crear el worktree de carpeta entero, con sus repos adentro, enlaces, puertos y el rescate aplicado en cada uno, en vez de un worktree suelto por repo.
- `limpiar` y `cerrar` se juntan en `/arnes:cerrar`: cierra lo mergeado, recupera o descarta rescates y borra lo que sobre, con una sola pregunta. `limpiar` desaparece.
- El plan de cada workspace se recorta por rutas con prefijo, nunca por palabras sueltas; `planned` acepta archivos en la raíz del repo y no asigna a nadie un archivo sin prefijo que está en dos repos. La skill plan escribe los archivos previstos con el repo delante.
- Un `git fetch` de origin por repo cada dos minutos, compartido por behind, check y materialize y por los worktrees del repo.
- Cada edición en el worktree de una carpeta también guarda el rescate, como mucho una vez por minuto.

### Corregido
- Un worktree con el lock de una sesión `claude -p --worktree` que ya terminó se desbloquea y se borra; con la sesión viva, o un lock sin PID, no se toca.
- La rama `worktree-<nombre>` del repo de carpeta que queda tras un borrado por fuera entra en lo que `clean` lista y borra.

## [0.6.8] - sin etiquetar

Ronda del worktree de carpeta seguro: que nada sin commitear se pierda cuando Claude Code borra el worktree de una carpeta sin pasar por el arnés (`docs/PLAN.md` §7). Rama `feature/worktree-carpeta-seguro`, probada con Claude Code 2.1.308 y 2.1.309 (se actualizó solo a mitad de la corrida) y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y corridas de punta a punta con `claude -p` sobre la carpeta de prueba con dos repos.

### Añadido
- El rescate: después de cada turno y al arrancar, en el worktree de una carpeta, lo que cada repo de adentro tiene sin commitear se guarda en `refs/arnes/rescate/<nombre>` de su propio repo, con un índice aparte y sin tocar el del worktree (`lib/rescate.js`, `worktree-carpeta.js protect`, Stop y SessionStart). Sobrevive al borrado de la carpeta.
- El marcador `.arnes-trabajo-pendiente` en la raíz del worktree de carpeta mientras algún repo tenga cambios sin commitear o commits sin subir: Claude Code lo cuenta como trabajo y pregunta antes de borrar. El arnés no lo cuenta como trabajo del repo de carpeta.
- SessionStart y `worktree-ledger.js pending` avisan de los rescates que quedaron sin su worktree; el registro del issue los lista; `issues.js recover <slug>` los devuelve en un worktree nuevo del repo, en su rama y con los cambios como estaban; `clean --con-cambios` los descarta; `/arnes:limpiar` los ofrece aparte, recomendando recuperarlos, aunque el issue no esté entregado.
- Al aprobar el plan en el worktree nativo de un repo solo, la rama `worktree-<nombre>` pasa a la del issue (`feature/<nombre>`) con `git branch -m`, solo si todavía no se subió; si ya está en origin, no se renombra y se dice.

### Cambiado
- El guard niega `git worktree remove` del worktree de carpeta mientras tenga enlaces: con git 2.53 en Windows, `git worktree remove --force` sigue las junctions y vacía lo que hay detrás.
- `issues.js clean` deja el worktree de una carpeta con un repo sucio salvo con `--con-cambios`, que lo borra con su rescate.
- La ruta de un workspace se compara por la ruta real (`realpathSync.native`), también para un archivo que todavía no existe.

### Corregido
- El test del lock de una sesión muerta fallaba de vez en cuando porque Windows reusa enseguida el pid de un hijo que salió: ahora usa un pid sin proceso, probado como lo prueba SessionStart.

### Descartado
- El worktree de cada repo fuera de la carpeta, en `<repo>/.claude/worktrees/<nombre>`, visto por un enlace: Claude Code 2.1.308 limita las escrituras de una sesión en worktree a su carpeta por la ruta real y niega escribir por el enlace, así que el dev no pudo construir. Quedó en la historia (`c26b1bf`) y se revirtió en `4782958`.

## [0.6.7] - sin etiquetar

Ronda de plan al estilo del escritorio: el flujo que la persona vio en una sesión del escritorio sin el arnés, y los remates de la prueba de init (`docs/PLAN.md` §6.3, §7 y §8). Rama `feature/plan-escritorio`, probada con Claude Code 2.1.308 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y corridas de punta a punta con `claude -p` sobre una carpeta de prueba con dos repos.

### Añadido
- El issue se trabaja en un worktree nativo de Claude Code, siempre desde main al día, también en una carpeta multi-repo: al aprobar, plan mueve la sesión con EnterWorktree y lo dice en la pregunta de aprobación; la rama en el checkout queda como alternativa, o por defecto con `integration.workInPlace`. En el worktree de una carpeta, el arnés trae cada repo del plan como worktree de git en `feature/<nombre>`, con `node_modules` enlazado, `.env` copiados y puertos corridos (`worktree-carpeta.js`), al arrancar y en un PostToolUse nuevo de EnterWorktree; al salir con ExitWorktree quita enlaces y worktrees antes de borrar, y las ramas quedan. SessionStart limpia el registro de worktrees huérfanos.
- "Inicia la app": `build.js app` la levanta desde el worktree con los puertos en el entorno del proceso, que ganan a cualquier `.env`; `commands.app` en el schema.
- La lista de tareas de la sesión para el escritorio: una por etapa y por workspace, en la timeline, con su estado sacado de los start y end (`plan-state.js tareas`), y cada etapa se la pasa a TodoWrite.
- Investigar y decidir antes del plan: el bloque `plan` del manifiesto (`references`, `decide`), las secciones Referencias y Decisiones, escritas para quien aprueba el negocio.
- La prueba manual en el plan, con `testEnvironments` en el manifiesto, y repetida en el MR.
- La evidencia del grafo: el guard anota cada consulta, el plan suma Mapa consultado, y la banda dice `Planeando · grafo 3 consultas` o marca el grafo sin consultar. Los worktrees enlazan el grafo del principal.
- El registro de lo creado por issue (`.tmp/harness/issues/<slug>.json`) y su limpieza segura: `issues.js clean`, la pregunta al final de ship y la skill `/arnes:limpiar`, que nombra sin tocar lo que no conoce.
- El ciclo del issue hasta main: estados de planeado a cerrado anotados por los scripts, SessionStart con los issues abiertos y su edad, `/arnes:cerrar` cuando glab o gh dicen que el MR se mergeó, y `integration.merge: "local"` con merge `--no-ff` verificado contra su primer padre.

### Cambiado
- ship se vale solo: resuelve integrar, verificar y revisar, y se detiene solo con el gate en rojo, bloqueantes o una zona de riesgo sin revisión humana, con un bloque para la persona con la causa y los pasos. Un `.env` se queda fuera del commit en vez de frenar; sin nada que commitear entrega el push.
- La bandera de verificación no vence por tiempo, y guarda la huella con los fines de línea normalizados: un commit que solo cambió CRLF no es falla.
- El grafo, `.tmp` y `node_modules` nunca cuentan como código; init ofrece `graphify-out/` en el `.gitignore` de cada repo.
- init pregunta con recomendación cuando una rama remota trae la configuración (`adopt.js switch`), pone el flag del comando de test en su ronda (`probe --write`) y, con el árbol sucio, dice qué estorba a la línea base y la corre sola con `/arnes:init --baseline`.
- El ledger de worktrees queda para dividir un mismo issue en tareas que chocan; se quitó el parche de `node --env-file`.

### Corregido
Lo que salió de la prueba de punta a punta, dos sesiones y trece turnos, US$7,02 (`docs/PLAN.md` §7):
- La app no arrancaba desde `claude -p` en Windows: un `cmd.exe` separado y sin consola se colgaba. `build.js app` lanza un node separado que corre el comando con shell.
- La timeline de un worktree nativo vuelve al checkout principal antes de borrarlo, para que la corrida del issue no se pierda con la carpeta.
- El nombre corto del plan deja fuera las palabras vacías (`centros-costo-lineas-asiento`).
- La nota de una consulta al grafo no guarda las redirecciones.
- El registro del issue anota el worktree nativo en que corre aunque el plan sea trivial.

## [0.6.6] - sin etiquetar

Ronda corta de cierre antes de publicar (`docs/PLAN.md` §6.4 y §7). Rama `feature/cierre-nativos`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y una corrida con `claude -p --worktree` sobre un clon de api-academico con un bloqueante de revisión.

### Corregido
- El reporte del reviewer lo guarda el hilo principal: Claude Code no deja a un subagente escribir archivos de reporte. El reviewer vuelve a solo lectura (Read, Grep y Glob) y devuelve el reporte como texto; la skill review lo escribe en `.tmp/harness/review/report.md` antes de `mark`. `mark --clean` sigue para las revisiones sin hallazgos, y la regla de plan-guard sobre el reviewer queda como defensa.
- ExitWorktree en un worktree nativo con trabajo sin subir dice qué hacer: subir la rama con `/arnes:ship`, o commitear y subir a mano; nunca integrate.
- Los costos de las corridas de punta a punta de la 0.6.4 y la 0.6.5 en `docs/PLAN.md`: `total_cost_usd` de `claude -p --resume` es el acumulado de la sesión.

## [0.6.5] - sin etiquetar

Ronda de worktrees nativos: en un repo solo, el arnés se monta sobre los worktrees que crea Claude Code (`claude --worktree`, el escritorio), y sus propios worktrees por set quedan para la carpeta multi-repo y las tareas de un mismo issue (`docs/PLAN.md` §7). Rama `feature/worktrees-nativos`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y una corrida de punta a punta con `claude -p --worktree` sobre un clon de api-academico.

### Añadido
- `lib/worktree-nativo.js`: si el cwd está en `<principal>/.claude/worktrees/<nombre>`, con su checkout principal y su rama.
- SessionStart en un worktree nativo enlaza el `node_modules` del principal donde falta y desplaza una vez los puertos de los `.env` que copió `.worktreeinclude`, y lo dice.
- `regeneratesNodeModules` en el manifiesto de workspace; build avisa si el plan lo toca con `node_modules` enlazado, y `build.js deps --write` instala adentro.
- `adopt.js worktreeinclude`, `adopt.js baseref` y `adopt.js graph`, en la ronda de init. adoption-check suma una sección informativa con `.worktreeinclude` y el grafo.
- `gate-flag.js write --base <ref>`: la bandera de lo que entró con un merge ya commiteado.

### Cambiado
- Un worktree nativo es su propio proyecto, con su plan y su timeline: plan-guard ya no busca el plan en el principal.
- En un worktree nativo, plan toma la rama del worktree sin preguntar ni crear otra, y ship commitea ahí; entregar es el push y el MR.
- `worktree-ledger.js pending` lista también los worktrees nativos con commits sin subir o cambios sin commitear, y SessionStart los avisa; nunca los borra. ExitWorktree en un nativo se niega solo con trabajo sin subir.
- Después de integrate y de sync, verify corre contra el primer padre del merge (decisión 11 de §12).
- Los mensajes de SessionStart y del Stop siguen la voz del arnés: sin rutas ni nombres de scripts, y con el nombre de una skill solo cuando la persona la escribe.
- La skill worktree y `docs/PROBADORES.md` dicen cuándo `claude --worktree` y cuándo `/arnes:worktree open`.
- `build.js` reconoce archivos previstos con extensiones de hasta diez letras, como `schema.prisma`.

### Corregido
- El guard sigue negando `git worktree remove` con el enlace de `node_modules` vivo, también en un worktree nativo.

## [0.6.4] - sin etiquetar

Ronda de init amable: init le habla a quien no conoce el arnés, con una sola ronda de preguntas, y la voz de todas las skills se acorta (`docs/PLAN.md` §2, §6, §7 y §8). Rama `feature/init-amable`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` de los mods y una corrida de punta a punta de los worktrees con `claude -p` sobre un clon de api-academico.

### Añadido
- `afterBuild` en el manifiesto de workspace: `commands` y la condición `onlyIfLocalDb` (`env` y `pattern`). Al cerrar build, `build.js after` lista los comandos solo si el `.env` del workspace apunta a la base local; si no, quedan en "pendiente tuyo" con el host y el puerto. El guard deja pasar un comando de `forbidden` solo si es uno de `afterBuild` y la condición se cumple. init-draft y `adopt.js complete` lo proponen cuando hay scripts de sync.
- `issue-branch.js behind`: al empezar, plan hace fetch y dice cuántos commits va atrás de origin cada rama, y ofrece `/arnes:sync`. No hace pull.
- `informe.js path <etapa>`: la ruta del informe de cada etapa en `.tmp/harness/informes/` y si la frase del verde ya salió en la corrida.
- init y setup anotan su `start` y su `end` en la timeline, también sin manifiesto (`timeline.js --dir`); arnes-ui muestra setup como Preparando.

### Cambiado
- `init-draft --write` escribe cada manifiesto que falta y deja los existentes; `--force <ruta>` pisa uno a propósito, archivo por archivo. `--gitignore` escribe solo el `.gitignore` de la carpeta.
- La composición que propone init-draft trae `integration` (`feature/`, la misma rama en todos) y el `contract` de cada repo según su stack, y la rama de cada repo es donde vive su manifiesto, o la por defecto desde cero; nunca la rama en que está la persona.
- `adopt.js folder-settings` sin `--marketplace` toma la url y el ref del marketplace instalado.
- La skill init mira todo antes de preguntar, hace una sola ronda numerada con recomendación, contestable con "sí a todo", y al cerrar dice cómo se sigue sin mandar a invocar etapas a mano. setup también pregunta en una sola ronda.
- Mientras init o setup están en curso, UserPromptSubmit no agrega la línea que pide cargar arnes:plan y arnes-mod no pregunta a haiku.
- La ronda acotada de review revisa todo el diff desde la marca anterior, con los archivos nuevos, y escala a completa solo si el cambio toca riskPaths o es más grande que el diff revisado.
- La entrada del test-writer trae el código de cada archivo, hasta 400 líneas, y la del dev el `CLAUDE.md` del workspace sin frontmatter.
- Los reportes de las skills: una línea de qué pasó y lo que la persona tiene que decidir o hacer; el detalle va al informe. En el chat quedan textuales los bloqueantes del reviewer y las preguntas del plan, y la frase del verde sale una vez por corrida.
- `docs/PROBADORES.md` suma preguntas frecuentes (pull de main, cuándo se entrega, cuándo nace la rama del issue, cuándo y cómo usar un worktree) y muestra la ronda de init como la ve la persona.

### Corregido
- Al abrir un worktree, `DB_PORT` y las demás variables de base ya no se desplazan con los puertos de la app.
- `worktree open` avisa cuando el `node_modules` enlazado trae el cliente de Prisma, que carga el `.env` del principal, y dice cómo arrancar la app del worktree: `node --env-file=.env <entrada>`.

## [0.6.3] - sin etiquetar

La rama del issue nace al aprobar el plan, desde main fresco (`docs/PLAN.md` §6.3). Rama `feature/rama-del-issue`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict` y `node --test`.

### Añadido
- `issue-branch.js`, que la skill plan corre al aprobar, en todos los workspaces del plan y con el mismo nombre: el prefijo de `integration.branchPrefix` y un nombre corto sacado del título del plan.
  - En la rama por defecto y con el árbol limpio, hace `git fetch origin`, la adelanta a `origin/<defaultBranch>` si es fast-forward y crea la rama del issue.
  - Con cambios sin commitear, crea la rama igual, porque git se los lleva, pero no adelanta la por defecto, y lo dice.
  - La rama queda en la línea `Rama:` del plan y en la timeline.

### Cambiado
- En otra rama, plan no asume nada: pregunta en el mismo mensaje de aprobación, con recomendación, si crea la rama nueva desde main actualizado o construye en la rama actual.
  - Con el sí, se niega mientras haya cambios sin commitear.
  - Con la alternativa, se queda y solo avisa si va atrás de main.
- Ship reutiliza la rama que creó plan, y la crea solo si nadie lo hizo antes.
- `docs/PROBADORES.md` dice que la rama la crea el arnés al aprobar el plan, y que la persona solo cuida de no dejar cosas a medias sin commitear.

## [0.6.2] - sin etiquetar

Ronda de menos vueltas por agente, sin perder determinismo: lo que un script puede juntar lo junta antes, y el agente lee su entrada. Rama `feature/menos-turnos`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods, y medida con una corrida antes y otra después sobre un clon de api-academico (`docs/PLAN.md` §10).

### Añadido
- `build.js input --ws <ws>`, que arma `.tmp/harness/build/<ws>-input.md` con los comandos, las riskPaths y los forbidden del workspace, el plan en lo que lo toca, el contrato del back si es el front y el texto de las reglas que aplican a los archivos previstos. Con `--para test-writer --files …`, la entrada del test-writer, con la ruta del spec de cada archivo.
- `review.js mark --clean`, que escribe el reporte mínimo de una revisión sin hallazgos.
- En `arnes-mod`, un atajo determinista solo para preguntas: si el mensaje empieza con signo de interrogación o con cómo, qué, cuál, dónde, por qué, explica o muestra, y no trae un verbo de cambio, no pide plan ni llama a haiku.

### Cambiado
- `review.js input` mete en el bloque del diff, enteros y numerados, los nuevos sin trackear que caen en `codeGlobs`, con el tope de 400 líneas por archivo; la nota nombra los que quedan fuera.
- `review.js input` vuelca el texto sin frontmatter de las reglas que aplican y pone en una línea las que no, con un tope de 40000 caracteres de reglas y de 250000 del input entero, y dice qué omitió.
- La skill build le pasa al dev su entrada en vez del plan entero, y verify hace lo mismo con el test-writer. `dev.md` y `test-writer.md` dejan de leer el `CLAUDE.md`, las reglas y `harness.json` por su cuenta.
- El reviewer escribe su reporte en `.tmp/harness/review/report.md`: gana Write, y `plan-guard.js` le niega cualquier escritura fuera de `.tmp/harness/review`. El hook lo identifica por `agent_type`.
- `docs/PROBADORES.md` y `adopt.js folder-settings` instalan desde la rama `probadores`, con nombre fijo: publicar es un push sobre ella.

### Quitado
- El agente `test-runner`: verify corre `ci-gate.js` directo desde hace dos versiones.

## [0.6.1] - sin etiquetar

Ronda corta antes de cerrar la fase de setup: los worktrees que abre el ledger nacen usables. Cierra el punto 8 de `docs/PLAN.md` §7. Rama `feature/worktrees`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods.

### Añadido
- `worktree-ledger.js open` enlaza `node_modules` del checkout principal en cada workspace del worktree, con junction en Windows y symlink en el resto, y copia los `.env*` de su raíz salvo `.env.example`. Registra en el ledger lo que enlazó y lo que copió.
- `--no-link`, que en vez de enlazar instala dentro del worktree con el paso deps de `setup.js`, para un issue que regenera algo en `node_modules`.
- Puertos por set: un desplazamiento de 10 por set abierto en las variables `*PORT` de las copias de `.env`, y el `localhost:<puerto>` de otro workspace del set reescrito al nuevo. open imprime el mapa y `list` lo repite. `--port-offset N` lo elige, y `0` no toca nada.
- `lib/links.js`, con el enlace que ya usaba ci-gate y un `unlink` que nunca borra en recursivo.

### Cambiado
- `integrate` y `close` deshacen en orden: quitan los enlaces registrados con `rmdir` o `unlink`, borran las copias de `.env` y recién entonces corren `git worktree remove`. Si algo falla a medias, el registro queda abierto con `undo` y no hay remove. Es por el incidente del 2026-10-19: un `git worktree remove` siguió una junction y borró el `node_modules` de verdad del checkout principal.
- El guard niega `git worktree remove`, y `worktree-remove.js` un `ExitWorktree` con `remove`, mientras el worktree tenga un enlace del arnés vivo.
- La skill build le dice al dev en un worktree que arranque la app desde ahí con los puertos del mapa. La skill worktree muestra el mapa y explica `--no-link`.
- `docs/PLAN.md` §7, `docs/PROBADORES.md` y el README cuentan qué trae un worktree y cómo se levanta la app adentro.

## [0.6.0] - sin etiquetar

La fase de setup, por el ciclo dos del issue de talleres con la 0.5.3 desde la raíz de academico: el flujo salió como debía, y los tropiezos del compañero fueron todos de preparación (`docs/PLAN.md` §10). Rama `feature/setup`, probada con Claude Code 2.1.306 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods.

### Añadido
- `/arnes:setup <url o ruta del repo de carpeta> [destino]`, que solo invoca la persona, y `scripts/setup.js` con sus pasos idempotentes: `clone`, `repos`, `deps`, `env`, `probe`, `baseline`, `graph`, `claude-md`, `permissions` y `close`. Sin `--write` cada paso dice qué haría; `/arnes:setup --check` no toca nada. Nunca corre un comando de `forbidden` ni escribe credenciales (`docs/PLAN.md` §8).
- El repo de carpeta: la composición, el `CLAUDE.md` de la carpeta, `.claude/settings.json` con el marketplace fijado y un `.gitignore` con los repos anidados, versionados en un repo propio de la carpeta.
- `remote` y `branch` por repo en el schema de la composición. `init-draft` los rellena, sin usuario ni token, y escribe el `.gitignore` de la carpeta.
- `adopt.js folder-settings`, que escribe el `settings.json` del repo de carpeta con `extraKnownMarketplaces` y `enabledPlugins`.
- `adopt.js complete`, y su paso en init, para completar un manifiesto existente campo por campo: `conventions`, `forbidden` y `contract`.
- `hooks/agents.js` en `SubagentStart` y `SubagentStop`: el registro de los agentes `arnes:*` vivos.

### Cambiado
- `ship.js committed` compara contra la bandera solo los archivos que entraron al commit. Un tocado que quedó fuera es una nota, `quedó sin commitear: <archivo>`, y no una FALLA.
- `arnes-ui` muestra una corrida que cerró con ship en otra sesión como "última corrida", en una línea con sus etapas y costo, y deja la cronología vacía hasta el próximo `start plan`.
- El Stop avisa en una línea y no bloquea si hay un build abierto en la timeline o un agente del arnés corriendo.
- `.gitlab-ci.yml` fija el CLI en 2.1.305 y suma el job `plugin-test` con `claude plugin test` de `arnes-ui` y `arnes-mod`.
- `docs/PROBADORES.md` empieza por setup, e init queda para adoptar un proyecto sin manifiesto. El README y `docs/PLAN.md` §8 registran el repo de carpeta, y §10 las medidas del ciclo dos.

## [0.5.3] - sin etiquetar

Tercera ronda de correcciones antes del piloto, por la corrida de un compañero de front con la 0.5.2 en su Mac: el mismo CRUD de talleres sobre academico (`docs/PLAN.md` §10). Rama `feature/pre-piloto-3`, probada con Claude Code 2.1.304 y Node 24 con `claude plugin validate --strict`, `node --test`, `claude plugin test` y `tsc` de los mods; `arnes-mod` con 2.1.305.

### Añadido
- `arnes-mod` nace con una sola pieza, la cuarta capa del plan obligatorio: un `prompt.submit` que, sin plan en curso, pregunta a haiku si el mensaje de la persona pide un cambio de código y, si sí, adjunta como `context` la instrucción de cargar `arnes:plan`. Una pregunta, un comando con barra o un mensaje corto pasan intactos, y si el modelo no responde el prompt sigue tal cual. Va como `context` porque un texto reescrito con `/arnes:plan` no dispara la skill: el CLI resuelve los comandos antes de `prompt.submit` (`docs/PLAN.md` §6.5).
- `plan-guard.js`, un PreToolUse sobre Edit y Write: sin plan aprobado en la corrida, niega escribir código de un workspace, también a los agentes.
- `plan-state.js`: el estado del plan, la aprobación, que exige el plan escrito y una respuesta de la persona después, y el plan trivial de `/arnes:plan --trivial`, que solo vale si lo escribió la persona.
- UserPromptSubmit recuerda en una línea, sin plan en curso ni código tocado, que un pedido de código empieza por `arnes:plan`; el protocolo de SessionStart suma la regla.
- `conventions.js` y `conventions` en el schema: convenciones mecánicas sobre lo que cambió, en rojo con archivo y línea, en ci-gate antes del lint; el dev las corre antes de entregar e init-draft propone cuatro para JS y TS.
- `lib/database.js`: lo que toca una base va a `forbidden` desde init-draft, el guard lo niega diciendo que lo corre la persona, y adoption-check lo comprueba en la comprobación 3.

### Cambiado
- Solo un mensaje de la persona abre turno: el aviso de un agente en segundo plano ya no reescribe la foto del turno ni cuenta como respuesta, y el Stop ve lo que escribieron los devs.
- build carga verify cuando el último dev entrega, en vez de cerrar el turno con "sigue verify".
- init-draft y adoption-check dicen en qué rama está un repo sin manifiesto y qué rama remota lo trae; `init-draft --write` se niega en ese caso sin `--force`, y adoption-check lo da como FALTA.
- `timeline.js` ya no escribe la nota `aprobado` del plan: la escribe `plan-state.js approve`.
- El reviewer deja de reportar lo que cubren las convenciones del manifiesto.
- `docs/PROBADORES.md` pide `git fetch` y la rama con el manifiesto antes de init, avisa que los comandos contra una base los corre la persona, recomienda opus para la sesión principal e instala desde `feature/pre-piloto-3`; con el README, dice que `arnes-ui` se ve solo en la terminal.
- `docs/PLAN.md` §10 pone las medidas de la corrida del compañero junto a las de la primera.

## [0.5.2] - sin etiquetar

Segunda ronda de correcciones antes del piloto, por la primera corrida real del arnés: desde la raíz de academico, con api-academico y academico-front, un CRUD de talleres full-stack de punta a punta (`docs/PLAN.md` §10). Rama `feature/pre-piloto-2`, probada con Claude Code 2.1.304 y Node 24 con `claude plugin validate --strict`, `node --test` y `claude plugin test`.

### Añadido
- La cabecera del panel y el final de la banda muestran el reloj y el costo de la sesión, de `$.session.usage()`.
- La espera de la persona en toda la corrida: el Stop anota que el turno cerró, UserPromptSubmit que la persona respondió, y `timeline.js print` y el panel suman esos huecos aparte de las etapas.
- `arnes-ui` anota en la timeline el costo de cada etapa al cerrarla; `timeline.js print` muestra tiempo y costo por etapa, y el panel el total de la corrida.
- El Stop avisa "verificado, falta review" en una línea, sin bloquear, cuando hay bandera vigente y no hay revisión de ese contenido.
- `ship.js committed` compara después de cada commit el blob de cada archivo con el que verificó la bandera, que ahora guarda `blobs`, y da FALLA si un hook pre-commit lo reescribió.
- `adopt.js`, que `/arnes:init` ofrece después de los manifiestos: prueba que el test del manifiesto se lea, captura la línea base y anota los rojos que ya había, quita los hooks del arnés anterior, escribe los permisos en `settings.local.json` y el borrador del `CLAUDE.md` de una carpeta; `adoption-check` prueba el test en la comprobación 3.

### Cambiado
- La cronología del panel es la corrida de la timeline, desde el último `start plan`, y no se vacía en cada turno; las herramientas y los agentes ya no abren etapas, y solo las del hilo principal marcan el gate.
- Los tokens de cada agente en el panel van rotulados: `tok` y `de caché`.
- verify en verde y review con bloqueantes siguen a la etapa siguiente dentro de un issue en curso, aunque el turno empiece con una respuesta de la persona.
- `review.js` acota también la ronda que sigue a una revisión sin bloqueantes cuando el cambio no sale de lo revisado, y la skill anota el inicio de review después de que el script decide la ronda.
- El diff de la entrada del reviewer lleva el número de línea del archivo, para que cite líneas que existen.
- `ship.js check` avisa, y `adoption-check` da FALTA en la comprobación 1, cuando ningún workspace declara `contract`.
- plan deja la nota `esperando`: su espera la mide el turno, como la de las demás etapas.
- El README dice la versión en curso y suma a la matriz las filas de la 0.5.1 y la 0.5.2.
- `docs/PROBADORES.md` sigue esta ronda: instala desde `feature/pre-piloto-2` con la versión 0.5.2.

### Corregido
- `typecheck-baseline` y `ci-gate` descartan los diagnósticos de archivos ignorados por git, como `.next/dev/types/validator.ts`, y lo dicen en una línea.
- La entrada de la 0.5.1 no nombraba `docs/PROBADORES.md`, la guía de una página para los probadores que esa versión agregó.

### Para decidir después
- Que `test-baseline` lea `jest --json` en vez del texto de `--verbose`, y las medidas de la corrida: plan 3m27s, build 13m41s, verify 8m30s, review 5m06s y ship 1m55s (`docs/PLAN.md` §10 y §12).

## [0.5.1] - sin etiquetar

Ronda de correcciones antes del piloto, por la prueba manual y la corrida automática de la fase 3 (`docs/PLAN.md` §10). Rama `feature/pre-piloto`, probada con Claude Code 2.1.304 y Node 24 con `claude plugin validate --strict`, `node --test` y `claude plugin test`.

### Añadido
- `arnes-ui` muestra el costo en dólares de cada agente junto a sus tokens, con la misma fórmula de las etapas.
- `docs/como-funciona.html`: una página sin dependencias que explica el arnés desde cero, con la historia del CRUD de talleres.

### Cambiado
- `arnes-ui` saca la etapa de las skills de los `start` y `end` de la timeline, y no de `skill.prompt`, que el CLI salta.
- `plan` cierra su etapa al escribir el plan y anota aparte la espera de la aprobación; `timeline.js` acepta `note` y mide la espera.
- `arnes-ui` avisa gate en rojo y marca ✗ solo por el resultado de ci-gate, no por el código de salida de un jest o un tsc suelto.
- `plan` y `build` piden correr cada comando solo, como verify, review y ship.
- La línea `Plan:` del panel ya no repite "Plan:", y quita los caracteres invisibles y los de ancho dudoso.
- `docs/PLAN.md` §6.5 anota que el reviewer determinista de la fase 5 no puede colgarse de `classic.Stop`, y recomienda que lo exija el Stop clásico.
- Las rondas de corrección de review van acotadas al diff de la corrección, con tope de dos y en sonnet, y `mark` exige el reporte del reviewer.

## [0.5.0] - 2026-10-20

Fase 3: el flujo completo plan → build → verify → review → ship, con los cuatro agentes, los worktrees por issue, la memoria en markdown y la línea base de tests. Se construyó en dos mitades en paralelo, la 3a (verify, review y ship) y la 3b (plan, build, worktree, memory y sync), y se integró en `feature/fase-3`. Probado con Claude Code 2.1.304 y Node 24, con tests de juguete y de punta a punta sobre un clon local de api-academico. La prueba manual de `docs/PRUEBA-FASE-3.md` se hizo el 2026-10-20 en una sesión interactiva; su resultado está al final de la guía, y la fase 3 queda cerrada.

### Añadido
- `/arnes:plan` y `/arnes:build`, invocables por el modelo:
  - plan lee el issue con glab o gh, o toma el texto, y consulta graphify si existe. Escribe `.tmp/harness/plan.md` con criterios literales e inferidos, contrato, datos, archivos previstos, zonas de riesgo y preguntas cerradas, pide confirmación y anota `Aprobado:`.
  - build exige el plan aprobado y lanza un `arnes:dev` por workspace, el back primero, con el contrato textual.
- `/arnes:memory`, invocable por el modelo: decisiones en `docs/decisions/`, gotchas en `docs/gotchas.md` y recall con Grep y graphify, sin MCP.
- `/arnes:worktree` y `/arnes:sync`, solo por la persona: los worktrees por tarea, y traer `origin/<rama>` con respaldo, merge sin squash, `merged-files` y verify.
- Agente `dev` (sonnet, effort medium): implementa un workspace siguiendo su `CLAUDE.md` y sus rules, sin tests. Devuelve contrato, archivos, desviaciones, cobertura con `archivo:línea`, riesgo y pendientes.
- `worktree-ledger.js`:
  - abre worktrees por tarea en `wt/<rama-issue>/<slug>` desde la rama del issue, bajo `.tmp/harness/worktrees/`, con registro en `.tmp/harness/worktrees.json`;
  - integrate hace `merge --no-ff`, nunca squash, y close solo cierra sin commits propios;
  - pending sale con 1 si queda algo abierto.
- `merged-files.js`: lo que tocaron los dos lados de un merge y lo que entró.
- `SessionEnd` en `hooks.json`: suelta el lock de la sesión.
- `/arnes:verify`, invocable por el modelo. Por cada workspace tocado corre `ci-gate.js --base HEAD`: el typecheck contra una foto del HEAD, el lint de los tocados y los specs de test-select con la línea base. Lanza `arnes:test-writer` solo si hay código nuevo sin spec, escribe la bandera solo si el gate salió con 0 y anota la etapa en la timeline.
- `/arnes:review`, invocable por el modelo. Lanza `arnes:reviewer` una sola vez sobre el árbol final, con la entrada de `review.js input` y el plan si existe. Marca la revisión con `review.js mark` y resume los hallazgos por archivo, bloqueantes primero.
- `/arnes:ship`, solo por la persona:
  - exige bandera vigente y revisión del árbol actual sin bloqueantes;
  - usa la misma rama con el prefijo del manifiesto en los workspaces tocados;
  - hace un commit por workspace, back antes que front, con la convención del repo;
  - pide confirmación explícita antes de cualquier push o MR. Los MR van por `glab` o `gh`, con los enlaces cruzados y REVISIÓN HUMANA OBLIGATORIA si tocó riskPaths;
  - se niega con worktrees del issue sin integrar: `ship.js check` consulta el registro, y la skill corre `worktree-ledger.js pending --target <rama>` y muestra su salida.
  `--solo-commit` se detiene después de commitear.
- Agentes, cada uno con su `model` y su `effort`:
  - `reviewer` (opus): solo lectura con Read, Grep y Glob. Aplica la lista cerrada de bloqueantes de §6.4 y las reglas duras de `.claude/rules`, revisa el cumplimiento de criterios si hay plan y marca REVISIÓN HUMANA OBLIGATORIA.
  - `test-writer` (sonnet): specs solo para código nuevo o cambiado, contra el estándar de tests del repo.
  - `test-runner` (haiku): corre `test-baseline.js check` y copia la salida sin reclasificar.
- `test-baseline.js` (mejora 1 de §6.1): la línea base de tests commiteada.
  - Guarda conteos por spec y los saltos por nombre, con el formato `$defs.testBaselineFile` del schema y la ruta `testBaseline` opcional en el workspace.
  - Un test borrado o saltado, o un spec de la base que ya no existe, pone el gate en rojo.
  - Las fallas que coinciden exacto con una línea fechada de `tests/known-failures.txt` salen como preexistentes y no ponen rojo.
  - Con más tests que en la base, una nota avisa que los nuevos quedan protegidos solo al recapturarla.
- `review.js` (input, mark, check) y `ship.js` (check, branch, stage).
- `test-select --missing` y `touched-files --workspaces`.
- `adoption-check` comprobación 8: la línea base de tests, válida y commiteada.
- `arnes-ui` muestra los worktrees sin integrar de `.tmp/harness/worktrees.json`: `N wt sin integrar` en la banda, una sección en el panel, y "Lo que sigue" pide `/arnes:worktree integrate`.
- Tests con `node --test` para todo lo anterior. Incluyen:
  - la salida real de jest 30 en Windows como fixture;
  - una carpeta de juguete de dos repos para el ledger, merged-files, la sesión concurrente, los worktrees en SessionStart y en el Stop, el destino del ledger en ExitWorktree y en el guard, y la lectura de secretos por shell;
  - un test de presupuesto de líneas y política de invocación de las diez skills y los cuatro agentes.
  Más un test de `claude plugin test` para los worktrees en `arnes-ui`.
- `docs/PRUEBA-FASE-3.md` con la prueba manual, que reemplaza a las de las dos mitades.

### Cambiado
- `ci-gate` juzga sus tests con `test-baseline.js`. Un spec de la base borrado o una base ilegible ya no pasan como "sin cambios de código".
- `ci-gate`, y con él verify, reutiliza la foto de typecheck del base en `.tmp/harness/typecheck/<ws>.txt` mientras su hash sea el mismo, y solo la captura cuando cambió.
- El protocolo de `session-start`, el motivo del `Stop` y el del guard nombran las skills: verificar es `/arnes:verify`, revisar es `/arnes:review` e integrar es `/arnes:worktree integrate`. Ninguno manda ya a escribir la bandera a mano. El protocolo nombra además la lectura de secretos por shell entre lo denegado siempre.
- `session-start`:
  - lista los worktrees sin integrar y avisa de los de más de 7 días sin commits nuevos;
  - avisa si otra sesión de Claude está activa en el mismo proyecto, con un lock propio en `.tmp/harness/sessions`, y le pide a la segunda que trabaje en un worktree.
- `stop-gate` hace efectiva la condición (b): bloquea una vez el turno que dejó commits sin integrar en un worktree del issue.
- `worktree-remove` y el guard miden los commits sin integrar contra la rama destino registrada en el ledger. El comentario de `lib/branches.js` lo dice.
- El guard deniega `cat`, `type`, `Get-Content` y `head` de archivos de secretos, juzgando solo los archivos que leen. `read-guard.js` exporta `secretPath`.
- El validador de `lib/manifest.js` admite `additionalProperties` como schema y `minimum`, y valida contra una definición de `$defs` (`validateDef`).
- `docs/PLAN.md` §3, §4, §6, §7, §8, §10 y §12 registran los cambios y las decisiones de la fase 3.

### Quitado
- `docs/PRUEBA-FASE-3A.md` y `docs/PRUEBA-FASE-3B.md`, reemplazadas por `docs/PRUEBA-FASE-3.md`, y `docs/NOTAS-FASE-3B.md`, ya llevado al plan, al CHANGELOG y al README.

## [0.4.0] - sin etiquetar

Fase 2b: mod de interfaz. Escrito contra los tipos de la API de mods de Claude Code 2.1.303. `claude plugin validate` y `claude plugin test` corrieron con 2.1.304, porque el CLI se actualizó solo durante la sesión. La prueba manual (`docs/PRUEBA-FASE-2B.md`) se hizo el 2026-10-19 con 2.1.304; su resultado está al final de la guía. La repetición tras las correcciones salió como está escrita, y la fase 2b queda cerrada.

### Añadido
- `arnes-ui`: `hooks/register.tsx` con los hooks y el dibujo, `hooks/lib.ts` con lo puro (rutas, globs, formatos, lectura de comandos y de git) y el contrato de `$.state` en `types/index.d.ts`.
- Etapa por eventos:
  - `skill.prompt` de las skills `arnes:`.
  - `agent.spawn` y `turn.complete` de `arnes:dev`, `arnes:reviewer` y `arnes:test-writer`.
  - `tool.call` de los Bash que corren `ci-gate`, `typecheck-baseline`, `test-select`, o un segmento que empieza por un typecheck o un test del manifiesto.
  - `turn.step` muestra "Pensando…" y `session.compact` avisa.
- Banda de una línea sobre el prompt y entrada en la status line. Toast en cambio de etapa. Aviso en gate en rojo, Stop bloqueado, zona de riesgo tocada y compactación: va como toast y además como línea en el transcript (`$.ui.log`).
- El aviso de Stop bloqueado sale de la nota `bloqueado` que el `stop-gate` deja en la timeline, leída con el reloj del mod, y no de un hook en `classic.Stop`.
- La bandera se ve vencida si un archivo cambiado se modificó después de escribirla, por cualquier vía: el mod compara la fecha de modificación de lo que lista git, que se relee cada 15 s.
- Panel con la cronología (duración y costo por etapa), el promedio de las últimas corridas, los agentes con su botón "ver", el gate por workspace, el plan, la timeline y lo que sigue. `/arnes-panel` lo abre o lo cierra.
- Las últimas 20 corridas quedan en `$.store`. Cada corrida cierra con un resumen por etapa que marca la más lenta y la más cara.
- Tests del mod con `claude plugin test plugins/arnes-ui`.
- `/arnes:timeline` y `timeline.js print`: la timeline como texto, con la duración por etapa. Funcionan sin el mod.
- `docs/PRUEBA-FASE-2B.md` con la prueba manual.
- `read-guard.js`, un `PreToolUse` sobre Read, Glob y Grep: deniega abrir o buscar en `.env` y variantes (salvo `.env.example`), `~/.ssh`, `~/.aws`, credenciales, tokens y llaves privadas, haya o no manifiesto. `secretPaths` en el manifiesto amplía la lista por workspace. Es la mejora 2 de `docs/PLAN.md` §6.2.

### Cambiado
- `docs/PLAN.md` registra tres mejoras tomadas de otros arneses: la línea base de tests commiteada (§6.1 y §8, fase 3), el guard de lectura de secretos (§6.2) y el aviso de sesión concurrente (§6.2 y §7, fase 3). También registra la fase 7 de publicación (§10) y, en §12, la decisión abierta sobre la comunidad de plugins de Anthropic.
- Las guías de prueba usan `$PDV` en los comandos y `<PDV>` en los textos esperados, en vez de la ruta personal.
- `stop-gate` solo bloquea un turno que cambió la lista o el contenido de los tocados respecto de la foto que deja `prompt-context` en cada prompt (`.tmp/harness/turn.json`). Un turno que no tocó nada solo avisa.
- `arnes-ui` deduce el workspace de un comando de `cd`, `-C`, `--prefix` o el cwd. Si no puede, la etapa va sin workspace y no marca ningún gate; antes caía en el primer repo de la composición.
- `gate-flag`: la bandera lleva `contentHash`, el hash del contenido de cada tocado, trackeado o no. Editar un archivo ya tocado la vence. Una bandera escrita antes, sin ese campo, ya no vale.
- `stop-gate` anota cada bloqueo en la timeline (nota `bloqueado`), además del pase con `stop_hook_active`.
- `docs/PLAN.md` §3 registra tres hechos de la prueba manual con 2.1.304: un plugin interno salta el `classic.Stop` de los mods, que un toast se vea depende de la superficie, y el motor pone el prefijo de la status line de un mod.
- `docs/PLAN.md` §3 registra cuatro hechos de la API de mods 2.1.303: `process.spawn` no ve el Bash del modelo, el costo por etapa sale de `$.session.usage()`, un comando registrado no lleva prefijo de plugin y un mod no puede calcular la vigencia exacta de la bandera. §6.5b y §10 se ajustan a ellos.

## [0.3.0] - sin etiquetar

Fase 2: hooks clásicos. Probado con Claude Code 2.1.303 y Node 24 con tests por stdin. La prueba manual en una sesión interactiva se hizo el 2026-10-19 en api-academico; su resultado está al final de `docs/PRUEBA-FASE-2.md`.

### Añadido
- `hooks/hooks.json` con `SessionStart`, `UserPromptSubmit`, `PreToolUse` (`Bash|PowerShell` y `ExitWorktree`), `PostToolUse` (`Edit|Write`) y `Stop`. Cada hook corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/<x>.js"` con su timeout y su statusMessage.
- `guard.js`: parseo por segmentos que nunca mira heredocs ni argumentos de `echo`/`cat`. Deniega siempre `reset --hard`, push forzado, `clean -f`, `branch -D` y `git worktree remove` con commits sin integrar; con manifiesto, además, `forbidden`, `git commit` sin bandera vigente y `git add` masivo con `.env` o logs.
- `after-edit.js`: lint del archivo editado como contexto, y `typecheckFast` con debounce de 20 s por workspace; nunca bloquea.
- `session-start.js`: workspaces con rama y árbol sucio, últimas cinco decisiones y protocolo, todo en 40 líneas como máximo; sin manifiesto, cómo crearlo.
- `prompt-context.js`: estado corto con la bandera y las riskPaths tocadas.
- `stop-gate.js`: un bloqueo por turno si hay código sin bandera vigente; con `stop_hook_active`, aviso visible y nota en la timeline.
- `worktree-remove.js`: deniega `ExitWorktree` con `action: "remove"` si la rama del worktree tiene commits sin integrar.
- `lib/hook.js`, `lib/shell.js` y `lib/branches.js`.
- Tests por stdin para cada hook, incluidos el cwd dentro de un worktree, `stop_hook_active`, un archivo fuera de todo workspace y el falso positivo del heredoc; casos portados del git-guard de renova365.
- Permisos recomendados en el README.
- `docs/PRUEBA-FASE-2.md` con la prueba manual.
- `adoption-check` comprobación 7: un hook del `.claude/settings.json` de un repo o de la carpeta que corre un script propio de `.claude/hooks/` es una falta, porque corre además de los del plugin y pelea con ellos.

### Cambiado
- `docs/PLAN.md` §6.2: el rechazo de borrar worktrees pasa de `WorktreeRemove` a `PreToolUse` sobre `ExitWorktree` y al guard, porque `WorktreeRemove` solo se dispara para worktrees creados por un hook `WorktreeCreate`. Las reglas destructivas de git del guard valen también sin manifiesto.
- `touched-files` excluye el `.tmp/harness/` del proyecto, para que la propia bandera no cuente como archivo tocado en un proyecto de un solo repo.
- La timeline admite el evento `note`, que escriben los hooks.
- `docs/PLAN.md` §3 y §8: adoptar un repo empieza por quitar los hooks del arnés anterior de su `.claude/settings.json`; api-academico y renova365 los tienen.

## [0.2.0] - sin etiquetar

Fase 1: manifiesto y scripts. Probado con Claude Code 2.1.303 y Node 24, en academico (tres repos, uno PHP no adoptable todavía) y renova365 (dos repos).

### Añadido
- `schema/harness.schema.json` con los dos niveles del manifiesto: de repo (`workspaces`, con sus comandos) y composición de carpeta (`repos`, con `integration` y `contract`). `specPattern` acepta string o lista.
- `scripts/lib/manifest.js`: busca el manifiesto subiendo desde el cwd, compone repo y carpeta, valida contra el schema sin dependencias y resuelve el workspace de una ruta.
- `scripts/lib/timeline.js`, `lib/glob.js` y `lib/exec.js`.
- `touched-files.js`, `typecheck-baseline.js` (portado de renova365: clave sin línea ni columna, conteos por clave, exit 0/1/2/3/4), `test-select.js`, `gate-flag.js`, `adoption-check.js` y `ci-gate.js`. Todos leen del manifiesto, aceptan `--help` y documentan sus exit codes en la cabecera.
- `init-draft.js` y la skill `/arnes:init` completa: genera el manifiesto de cada repo y la composición de la carpeta, los valida, y con `--check` corre `adoption-check`.
- Tests con `node --test` sobre repos de juguete, con los casos portados de `harness-tests.js` de renova365 y los manifiestos reales como fixtures. Job `test` en el CI.

### Cambiado
- `docs/PLAN.md` §5: la unidad del manifiesto pasa a ser el repo, porque el CI de cada repo no veía el manifiesto de la carpeta. La carpeta pasa a ser una composición.
- El marketplace pasa de `claude-harness` a `agentic-harness`, para coincidir con el repo de GitLab.

## [0.1.0] - 2026-10-19

Fase 0: esqueleto. Probado con Claude Code 2.1.303.

### Añadido
- Marketplace `claude-harness` en `.claude-plugin/marketplace.json` con los plugins `arnes`, `arnes-ui` y `arnes-mod`.
- Plugin `arnes` con las carpetas `skills`, `agents`, `hooks`, `scripts` y `tests`, y la skill `/arnes:init` solo como esqueleto.
- Plugins `arnes-ui` y `arnes-mod` con solo su `plugin.json`; `arnes-mod` declara `arnes` como dependencia.
- README con principios, instalación, versionado en dos capas y matriz de compatibilidad.
- CI de GitLab que corre `claude plugin validate --strict` sobre el marketplace y los tres plugins.

### Cambiado
- El plan pasa de `PLAN-ARNES.md` a `docs/PLAN.md`.
