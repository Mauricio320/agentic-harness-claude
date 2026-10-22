---
name: review
description: Revisar el cambio antes de entregarlo o de abrir un MR. Lanza el reviewer del arnés una vez por ronda, la primera sobre el árbol final con los tocados y el plan si existe, y las siguientes solo sobre el diff desde la ronda anterior; marca REVISIÓN HUMANA OBLIGATORIA si toca riskPaths y resume los hallazgos por archivo, bloqueantes primero.
---

# arnes:review

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando `timeline.js` imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

La revisión va después de verify, sobre el árbol que se va a entregar. Si cambias algo después, la revisión deja de valer y ship lo rechaza.

## Pasos

1. Prepara la entrada: `node "S/review.js" input`.
   - **Qué deja:** `.tmp/harness/review/input.md`, con lo que el reviewer no puede sacar sin Bash: el HEAD de base, los tocados (los nuevos sin trackear de código, enteros en el diff), los borrados, las riskPaths tocadas, el contrato, las reglas del repo y el diff numerado con las líneas del archivo.
   - **Qué imprime:** una línea por workspace, la ronda y su modo (`ronda <n> de 3 · completa` o `· acotada`), la ruta del plan o "no hay", y la ruta de `input.md`.
   - **Si dice `sin marcar`:** esta misma revisión ya tiene su reporte guardado y el turno cerró antes de marcarla. No relances al reviewer: ve al paso 5 con ese reporte.
   - **Si dice que no hay nada que revisar:** anota `node "S/lib/timeline.js" note review --result ok --detail "sin tocados"` y termina.
   - **Si sale con 1:** es el tope de rondas, o nada cambió desde la revisión anterior. Di el motivo en una línea, anota `note review --result fail --detail "<motivo>"` y termina.

2. Anota el inicio con lo que decidió el script, nunca antes: `node "S/lib/timeline.js" start review --detail "ronda <n> <modo>"`.

3. Lanza el agente `arnes:reviewer` **una sola vez** en esta ronda. El prompt lleva solo esto:
   ```
   Lee <ruta de input.md>. Plan: <ruta del plan, o "no hay plan">.
   ```
   - **El modelo:** en una ronda acotada, pasa `model: "sonnet"` a la herramienta Agent. En una completa no pases `model`: el reviewer va en opus.
   - **No agregues tu opinión del cambio** ni un resumen de lo que hiciste: el reviewer juzga el árbol, no tu relato.
   - **No lo relances** para "confirmar" ni para que reconsidere un bloqueante.

4. El reviewer devuelve su reporte como texto: guárdalo con Write en `.tmp/harness/review/report.md`, entero y sin cambiar una coma, antes de marcar. Claude Code no deja a un subagente escribir archivos de reporte, así que lo guarda el hilo principal. Si respondió solo `Sin hallazgos.` con `BLOQUEANTES: 0`, no lo guardes: marca con `node "S/review.js" mark --clean`, que escribe el reporte mínimo, y salta el paso 5.

5. Marca la revisión con el número de la última línea del reporte (`BLOQUEANTES: <n>`): `node "S/review.js" mark --blockers <n>`.
   - **Si el reporte no trae esa línea:** cuenta las líneas `BLOQUEANTE` del reporte.
   - **Si mark sale con 1:** el árbol cambió durante la revisión. Dilo, anota `end review --result fail --detail "el árbol cambió"` y termina.
   - **Si sale con 2:** falta el reporte o su número no coincide. Guarda otra vez el texto del reviewer tal como llegó; si su número no cuadra, relánzalo una vez. Nunca escribas un reporte propio.

6. Anota el fin: `node "S/lib/timeline.js" end review --result ok|fail --detail "<n> bloqueante(s) · ronda <r> <modo>"`. Es `fail` si hay bloqueantes.

## Rondas de corrección

Con bloqueantes, se corrigen (los de specs con test-writer, los de código con dev), se corre verify entero, porque la bandera exige el contenido actual, y se vuelve a esta skill. Lo mismo si se aplican las sugerencias de una revisión sin bloqueantes. `review.js input` decide la ronda:
- **Ronda 1, completa:** el árbol entero, con el reviewer en opus.
- **Rondas 2 y 3, acotadas:** todo el diff desde lo revisado en la ronda anterior, con los archivos nuevos (como los specs que escribió test-writer), su reporte como entrada, y el reviewer en sonnet. Si el cambio toca riskPaths, o su diff es más grande que el que se revisó, la ronda es completa y va en opus.
- **Tope: dos rondas de corrección.** Si mark dice `tope`, no corrijas más: reporta a la persona los bloqueantes que siguen y espera su decisión. `review.js input --completa` vuelve a la ronda 1; córrelo solo si la persona lo pide.

## Al terminar

Dentro de un issue en curso (`.tmp/harness/plan.md` con `Aprobado:`) no te detengas entre etapas, aunque el turno haya empezado con la respuesta de la persona a una pregunta tuya. Solo paras si ella lo pidió o si hace falta una decisión suya.
- **Sin bloqueantes:** la etapa siguiente es ship, que corre la persona. Cierra con `Listo para /arnes:ship`.
- **Con bloqueantes:** sigue con la corrección, verify y esta skill en el mismo turno, hasta el tope.

## Reporte

Lo que lee la persona (docs/PLAN.md §2), sin nombres de scripts, códigos de salida, hashes ni rutas del plugin:
- **Riesgo:** si `review.js input` imprimió `REVISIÓN HUMANA OBLIGATORIA` en algún workspace, esa es la primera línea, con las rutas.
- **Los bloqueantes, en el chat y textuales:** la persona tiene que verlos. Cópialos del reporte del reviewer en su orden, cada uno con su archivo, su línea, su regla y cómo arreglarlo, sin suavizarlos ni reescribirlos.
- **Una línea** con cuántos bloqueantes y sugerencias hubo y en qué ronda, y lo que sigue: la corrección, o `Listo para /arnes:ship`.
- **El detalle va al informe:** `node "S/informe.js" path review` da la ruta. Escribe ahí las sugerencias, el cumplimiento de criterios del plan (o que no hubo plan), en una ronda acotada el estado de los bloqueantes anteriores, y la línea `BLOQUEANTES: <n>` con la ronda. En el chat, una línea con esa ruta y la del reporte del reviewer.
- **La frase** "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si informe.js dijo `frase: dila`. La revisión tampoco certifica el negocio: busca lo que está en la lista cerrada.
