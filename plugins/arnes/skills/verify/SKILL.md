---
name: verify
argument-hint: "[--base <commit>]"
description: Verificar, probar o comprobar un cambio de código antes de cerrar el turno o de commitear. Por cada workspace tocado corre el typecheck contra el HEAD, el lint de los tocados, los specs de test-select y la línea base de tests; escribe tests para el código nuevo sin spec y, si todo pasa, la bandera de verificación.
---

# arnes:verify

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando un script imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

**Después de un merge ya commiteado** (integrate de un worktree, sync, el merge local de ship), `$ARGUMENTS` trae `--base <commit>`, el primer padre del merge: pásalo igual a `verify.js run`. Contra HEAD no habría nada que verificar.

## Pasos

1. Corre `node "S/verify.js" run`, con `--base <commit>` si lo trae `$ARGUMENTS`. Es la verificación entera en una llamada: anota el inicio, busca los workspaces con cambios, corre el mismo gate que el CI en cada uno (el typecheck contra una foto del base, las convenciones del manifiesto, el lint de los tocados y los specs de test-select contra la línea base de tests y las fallas conocidas), escribe la bandera de cada workspace que salió en verde, anota el fin y deja el informe con todo.
   - **Sale con 3 y líneas `test-writer:`:** hay código nuevo sin spec. Por cada línea, lanza un agente `arnes:test-writer` con su carpeta y la ruta de su entrada, y nada más, sin `model` ni `effort`; si son varios workspaces, en paralelo. Cuando vuelvan, corre `node "S/verify.js" run --tras-tests` (con el mismo `--base`). Lo que siga sin spec va al informe con la razón que dio el test-writer; no bloquea.
   - **Sale con 0:** todos los workspaces en verde, con su bandera escrita; o nada que verificar.
   - **Sale con 1:** algún workspace en rojo, sin bandera. El código de salida decide: nunca escribas la bandera a mano porque la salida "parece" verde.

## Si algo falla

- **Un paso en rojo:** repórtalo y termina. Corregir es otro paso, y después de corregir se vuelve a verificar desde el principio.
- **Una falla de la línea base** (un test borrado o saltado, un salto no declarado, un spec de la base borrado): no se arregla recapturando la base para que cuadre. Recapturar (`test-baseline.js capture <ws>`) es una decisión de la persona, y su commit lleva `gates:` en el asunto.
- **Una falla `preexistente (<fecha>)`:** no pone rojo. Va al informe con su fecha.
- **Sin bandera vigente:** el commit se niega y el Stop bloquea una vez. No los rodees.

## Al terminar en verde

Verify es el final de build: no cargues review. La revisión es el gasto grande (un reviewer en opus leyendo el diff), y se paga una vez, en `/arnes:ship`, sobre el diff completo antes de commitear. Cierra con `Listo para /arnes:ship`, y en una línea que si la persona quiere la revisión antes, la pide con `/arnes:review`. Si ship te cargó para verificar, sigue con lo que ship pida.

## Reporte

Lo que lee la persona (docs/PLAN.md §2) es poco, y sin nombres de scripts, códigos de salida, hashes ni rutas del plugin:
- **En el chat:** una línea por workspace, en palabras (`api: compila, pasa el lint y los 12 tests que tocan lo cambiado`, o qué falló y en qué archivo), y la lista corta de lo que tiene que decidir o hacer ella, si hay algo.
- **El detalle ya está en el informe:** `verify.js run` lo escribe con la salida del gate de cada workspace sin resumir, lo que quedó sin spec y la línea de cada bandera, y dice su ruta en la línea `informe:` (la misma carpeta que da `node "S/informe.js" path verify`). Agrégale con Edit los specs que escribió el test-writer y la razón de lo que quedó sin spec. En el chat, una línea con esa ruta.
- **La frase** "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si la salida dijo `frase: dila`.
