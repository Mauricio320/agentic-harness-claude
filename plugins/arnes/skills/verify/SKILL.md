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
      - Si lista archivos, lanza una sola vez el agente `arnes:test-writer`. Pásale la carpeta del workspace, la lista tal cual y la ruta de `.tmp/harness/plan.md` si existe. No le pidas nada más.
      - Al volver, corre `--missing` otra vez. Lo que siga en la lista va al reporte con la razón que dio test-writer. No bloquea.

   b. **El gate:** corre `node "S/ci-gate.js" --ws <ws> --base HEAD`. Es lo mismo que corre el CI, sobre los cambios sin commitear:
      - el typecheck contra una foto del HEAD, con la clave y los conteos de typecheck-baseline;
      - el lint de los tocados que son código;
      - los specs de test-select, juzgados contra la línea base de tests y las fallas conocidas.

   c. **La bandera:**
      - **Si ci-gate salió con 0:** escribe `node "S/gate-flag.js" write <ws> --result pass` y guarda la línea que imprime.
      - **Si salió con 1:** no escribas bandera. El código de salida decide: nunca escribas pass porque la salida "parece" verde.

4. Anota el fin: `node "S/lib/timeline.js" end verify --result ok|fail --detail "<ws>: ok|fail, …"`. El resultado es `ok` solo si todos los workspaces verificados salieron con 0.

## Si algo falla

- **Un paso en rojo:** repórtalo con sus líneas y termina. Corregir es otro paso, y después de corregir se vuelve a verificar desde el principio.
- **Una falla de la línea base** (un test borrado o saltado, un salto no declarado, un spec de la base borrado): no se arregla recapturando la base para que cuadre. Recapturar (`test-baseline.js capture <ws>`) es una decisión de la persona, y su commit lleva `gates:` en el asunto.
- **Una falla `preexistente (<fecha>)`:** no pone rojo. Repórtala aparte con su fecha.
- **Sin bandera vigente:** el guard niega el `git commit` y el Stop bloquea una vez. No los rodees.

## Reporte

Una sección por workspace verificado:
- **El gate:** las líneas de ci-gate tal cual (base, typecheck, lint, tests y sus motivos), sin resumirlas.
- **test-writer:** si se lanzó, los specs que escribió y lo que quedó sin spec, con su razón.
- **La bandera:** la línea de `gate-flag.js write`, o "sin bandera" con el paso que falló.

Cierra con esta frase, literal: **Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.**
