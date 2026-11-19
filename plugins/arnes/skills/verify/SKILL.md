---
name: verify
argument-hint: "[--base <commit>]"
description: Verificar, probar o comprobar un cambio de código al terminar de construirlo y antes de entregarlo o de commitear. Por cada workspace tocado corre el typecheck contra el HEAD, el lint de los tocados, los specs de test-select y la línea base de tests; escribe tests para el código nuevo sin spec y, si todo pasa, la bandera de verificación.
---

# arnes:verify

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando un script imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

**Después de un merge ya commiteado** (integrate de un worktree, sync, el merge local de ship), `$ARGUMENTS` trae `--base <commit>`, el primer padre del merge: pásalo igual a `verify.js run`. Contra HEAD no habría nada que verificar.

## Pasos

1. Corre `node "S/verify.js" run`, con `--base <commit>` si lo trae `$ARGUMENTS`. Es la verificación entera en una llamada: anota el inicio, busca los workspaces con cambios, corre el mismo gate que el CI en cada uno (el typecheck contra una foto del base, las convenciones del manifiesto, el lint de los tocados y los specs de test-select contra la línea base de tests y las fallas conocidas), escribe la bandera de cada workspace que salió en verde, anota el fin y deja el informe con todo.
   - **Sale con 3 y líneas `test-writer:`:** hay código nuevo sin spec. Por cada línea, lanza un agente `arnes:test-writer` con su carpeta y la ruta de su entrada, y nada más, sin `model` ni `effort`; si son varios workspaces, en paralelo. Cuando vuelvan, corre `node "S/verify.js" run --tras-tests` (con el mismo `--base`). Lo que siga sin spec va al informe con la razón que dio el test-writer; no bloquea.
   - **Si el plan pide pruebas de integración** y el reporte del test-writer no nombra ninguna, corre una vez `node "S/verify.js" run --integracion` (con el mismo `--base`): arma su entrada de integración y sale con 3 y sus líneas `test-writer:`, que lanzas igual que arriba, y vuelves con `--tras-tests`.
   - **Sale con 0:** todos los workspaces en verde, con su bandera escrita; o nada que verificar.
   - **Un tocado «fuera del alcance de lint del repo»** no es falla: el repo nunca lo lintó. Dilo en una línea y no propongas cambiar la configuración por eso.
   - **Sale con 1:** algún workspace en rojo, sin bandera. El código de salida decide: nunca escribas la bandera a mano porque la salida "parece" verde.

## Si algo falla

- **Un paso en rojo:** corrígelo y vuelve a verificar desde el principio, en el mismo turno y sin pedir permiso: en rojo se corrige, no se pregunta. El código lo corrige el dev de ese workspace, relanzado con la falla concreta; un spec que escribió el test-writer, él. Solo paras si la falla es de configuración (propónle el cambio a la persona, que lo aprueba respondiendo que sí), si corregir pide una decisión de negocio que el plan no tomó, si lo que falla ya fallaba sin este cambio (un test que no tocaste y que no depende de lo que cambiaste: no lo persigas ni repitas la suite por él), o si la salida dice `tope:` (tres vueltas en rojo desde su último mensaje); ahí, dile qué sigue fallando y qué propones, y termina.
- **Una falla de la línea base** (un test borrado o saltado, un salto no declarado, un spec de la base borrado): no se arregla recapturando la base para que cuadre. Un spec renombrado no es falla: el gate lo reconoce por su contenido, y en verde la base pasa sola al nombre nuevo; no deshagas el renombre. Recapturar (`test-baseline.js capture <ws>`) es una decisión de la persona, y su commit lleva `gates:` en el asunto.
- **Una falla `preexistente (<fecha>)`:** no pone rojo. Va al informe con su fecha.
- **Sin bandera vigente:** el commit se niega y ship no entrega. No lo rodees. El turno sí puede cerrar sin ella: mientras la persona itera, la verificación va al final.

## Los ejemplos del plan

En verde, y antes de cerrar, corre de verdad cada ejemplo de `## Ejemplos` del plan (E1, E2…): verde dice que compila y testea, no que el caso de la persona funciona. Sin plan, o si dice `sin ejemplos`, sáltalo.
- **Cómo:** por el camino real y con el dato tal como está escrito: la app levantada (la skill build dice cómo) y la llamada o la pantalla; una prueba de integración del repo que pase por la consulta o el endpoint de verdad; o la consulta en solo lectura contra la base local. Un test con mocks de lo que se prueba no cuenta: eso ya lo midió el gate.
- **Lo que no puedas correr** (pide una base que no es la local, un dato o un rol que no tienes, un servicio externo): no lo fuerces ni lo des por bueno. Queda `sin comprobar`, con el porqué.
- **Anótalo** con Write en `.tmp/harness/evidencia.md`, entero cada vez, una línea por ejemplo: `- E1: comprobado · <qué corriste> → <qué salió>` o `- E1: sin comprobar · <por qué>`. Un ejemplo que falla es un rojo: corrige como en «Si algo falla», verifica y córrelos otra vez; una comprobación anterior al último cambio no cuenta.
- **En el chat:** una línea con cuántos pasaron y, uno por uno, los que quedaron sin comprobar, como paso de la persona. Ship los repite antes del push.

## Al terminar en verde

Verify es el final de build: no cargues review. La revisión es el gasto grande (un reviewer en opus leyendo el diff), y se paga una vez, en `/arnes:ship`, sobre el diff completo antes de commitear. Cierra con `Listo para /arnes:ship`, y en una línea que si la persona quiere la revisión antes, la pide con `/arnes:review`. Si ship te cargó para verificar, sigue con lo que ship pida.

**Un ajuste que pide la persona con el plan aprobado**, dentro de los mismos workspaces, sin `riskPaths` y sin cambiar el contrato de la API ni los datos, no corre `plan-state.js start`, que reabre el plan y le quita la aprobación: anótalo en `## Decisiones` de `.tmp/harness/plan.md` como ajuste de la persona, y corrígelo. Mientras ella sigue ajustando no verifiques después de cada retoque: verifica cuando dé el ajuste por bueno, o lo pida, y siempre antes de entregar. Si cambia el contrato, toca `riskPaths` o cambia los datos, se re-planea como siempre, con la skill plan. Un pedido distinto (otra pantalla, otro repo, otro tema) tampoco es un ajuste, aunque sea chico: es un plan nuevo, corto si cabe en el carril. El plan aprobado no es permiso para lo que no describe.

## Reporte

Lo que lee la persona (docs/PLAN.md §2) es poco, y sin nombres de scripts, códigos de salida, hashes ni rutas del plugin:
- **En el chat:** una línea por workspace, en palabras (`api: compila, pasa el lint y los 12 tests que tocan lo cambiado`, o qué falló y en qué archivo), y la lista corta de lo que tiene que decidir o hacer ella, si hay algo.
- **El detalle ya está en el informe:** `verify.js run` lo escribe con la salida del gate de cada workspace sin resumir, lo que quedó sin spec y la línea de cada bandera, y dice su ruta en la línea `informe:` (la misma carpeta que da `node "S/informe.js" path verify`). Agrégale con Edit los specs que escribió el test-writer y la razón de lo que quedó sin spec. En el chat, una línea con esa ruta.
- **La frase** "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si la salida dijo `frase: dila`.
