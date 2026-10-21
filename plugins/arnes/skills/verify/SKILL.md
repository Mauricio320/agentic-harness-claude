---
name: verify
description: Verificar, probar o comprobar un cambio de código antes de cerrar el turno o de commitear. Por cada workspace tocado corre el typecheck contra el HEAD, el lint de los tocados, los specs de test-select y la línea base de tests; escribe tests para el código nuevo sin spec y, si todo pasa, la bandera de verificación.
---

# arnes:verify

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte.

## Pasos

1. Anota el inicio: `node "S/lib/timeline.js" start verify`.

2. Corre `node "S/touched-files.js" --workspaces`. Sale una línea por workspace con tocados: nombre, cuántos y si es adoptable.
   - **Sin ninguna línea:** di que no hay nada que verificar, anota `node "S/lib/timeline.js" end verify --result ok --detail "sin tocados"` y termina.
   - **Los no adoptables:** se reportan y no se verifican.

3. Por cada workspace adoptable de la lista, en el orden en que salieron:

   a. **Código nuevo sin spec:** corre `node "S/test-select.js" --ws <ws> --missing`.
      - Si lista archivos, arma su entrada con esa misma lista: `node "S/build.js" input --ws <ws> --para test-writer --files <archivo>...`. Deja `.tmp/harness/build/<ws>-test-writer-input.md` con los comandos, la ruta del spec y el código de cada archivo, las reglas que aplican y el plan en lo que toca a ese workspace.
      - Lanza una sola vez el agente `arnes:test-writer`. Pásale la carpeta del workspace y la ruta de esa entrada. No le pidas nada más.
      - Al volver, corre `--missing` otra vez. Lo que siga en la lista va al informe con la razón que dio test-writer. No bloquea.

   b. **El gate:** corre `node "S/ci-gate.js" --ws <ws> --base HEAD`. Es lo mismo que corre el CI, sobre los cambios sin commitear:
      - el typecheck contra una foto del HEAD, con la clave y los conteos de typecheck-baseline; la foto queda en `.tmp/harness/typecheck/` y se reutiliza mientras el HEAD no cambie;
      - las convenciones del manifiesto (`conventions`) sobre lo que cambió, antes del lint;
      - el lint de los tocados que son código;
      - los specs de test-select, juzgados contra la línea base de tests y las fallas conocidas.

   c. **La bandera:**
      - **Si ci-gate salió con 0:** escribe `node "S/gate-flag.js" write <ws> --result pass`.
      - **Si salió con 1:** no escribas bandera. El código de salida decide: nunca escribas pass porque la salida "parece" verde.

4. Anota el fin: `node "S/lib/timeline.js" end verify --result ok|fail --detail "<ws>: ok|fail, …"`. El resultado es `ok` solo si todos los workspaces verificados salieron con 0.

## Si algo falla

- **Un paso en rojo:** repórtalo y termina. Corregir es otro paso, y después de corregir se vuelve a verificar desde el principio.
- **Una falla de la línea base** (un test borrado o saltado, un salto no declarado, un spec de la base borrado): no se arregla recapturando la base para que cuadre. Recapturar (`test-baseline.js capture <ws>`) es una decisión de la persona, y su commit lleva `gates:` en el asunto.
- **Una falla `preexistente (<fecha>)`:** no pone rojo. Va al informe con su fecha.
- **Sin bandera vigente:** el guard niega el `git commit` y el Stop bloquea una vez. No los rodees.

## Al terminar en verde

Dentro de un issue en curso (`.tmp/harness/plan.md` con `Aprobado:`), sigue con la skill review en el mismo turno. Hazlo aunque el turno haya empezado con la respuesta de la persona a una pregunta tuya, por ejemplo si borrabas una caché. Solo paras si ella lo pidió.

## Reporte

Lo que lee la persona (docs/PLAN.md §2) es poco, y sin nombres de scripts, códigos de salida, hashes ni rutas del plugin:
- **En el chat:** una línea por workspace, en palabras (`api: compila, pasa el lint y los 12 tests que tocan lo cambiado`, o qué falló y en qué archivo), y la lista corta de lo que tiene que decidir o hacer ella, si hay algo.
- **El detalle va al informe:** `node "S/informe.js" path verify` da la ruta. Escribe ahí con Write las líneas de ci-gate de cada workspace sin resumirlas, los specs que escribió test-writer y lo que quedó sin spec con su razón, las fallas preexistentes y la línea de la bandera. En el chat, una línea con esa ruta.
- **La frase** "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si informe.js dijo `frase: dila`.
