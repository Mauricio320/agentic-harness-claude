---
name: review
description: Revisar el cambio antes de entregarlo o de abrir un MR. Lanza el reviewer del arnés una vez por ronda, la primera sobre el árbol final con los tocados y el plan si existe, y las de corrección solo sobre el diff de la corrección; marca REVISIÓN HUMANA OBLIGATORIA si toca riskPaths y resume los hallazgos por archivo, bloqueantes primero.
---

# arnes:review

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte.

La revisión va después de verify, sobre el árbol que se va a entregar. Si cambias algo después, la revisión deja de valer y ship lo rechaza.

## Pasos

1. Anota el inicio: `node "S/lib/timeline.js" start review`.

2. Prepara la entrada: `node "S/review.js" input`.
   - **Qué deja:** `.tmp/harness/review/input.md`, con lo que el reviewer no puede sacar sin Bash: el HEAD de base, los tocados (los nuevos para leerlos enteros), los borrados, las riskPaths tocadas, el contrato, las reglas del repo y el diff contra HEAD.
   - **Qué imprime:** una línea por workspace, la ronda y su modo (`ronda <n> de 3 · completa` o `· acotada`), la ruta del plan o "no hay", y la ruta de `input.md`.
   - **Si dice que no hay nada que revisar:** anota `end review --result ok --detail "sin tocados"` y termina.
   - **Si sale con 1:** es el tope de rondas, o nada cambió desde la ronda con bloqueantes. Muestra el motivo, anota `end review --result fail --detail "<motivo>"` y termina.

3. Lanza el agente `arnes:reviewer` **una sola vez** en esta ronda. El prompt lleva solo esto:
   ```
   Lee <ruta de input.md>. Plan: <ruta del plan, o "no hay plan">.
   ```
   - **El modelo:** en una ronda acotada, pasa `model: "sonnet"` a la herramienta Agent. En una completa no pases `model`: el reviewer va en opus.
   - **No agregues tu opinión del cambio** ni un resumen de lo que hiciste: el reviewer juzga el árbol, no tu relato.
   - **No lo relances** para "confirmar" ni para que reconsidere un bloqueante.

4. Guarda el reporte del reviewer, entero y tal cual, en `.tmp/harness/review/report.md` con Write. Mark lo exige, y es la entrada de la ronda siguiente.

5. Marca la revisión con el número de la última línea del reporte (`BLOQUEANTES: <n>`): `node "S/review.js" mark --blockers <n>`.
   - **Si el reporte no trae esa línea:** cuenta las líneas `BLOQUEANTE` del reporte.
   - **Si mark sale con 1:** el árbol cambió durante la revisión. Dilo, anota `end review --result fail --detail "el árbol cambió"` y termina.
   - **Si sale con 2:** falta el reporte o su número no coincide. Corrígelo y vuelve a marcar.

6. Anota el fin: `node "S/lib/timeline.js" end review --result ok|fail --detail "<n> bloqueante(s) · ronda <r> <modo>"`. Es `fail` si hay bloqueantes.

## Rondas de corrección

Con bloqueantes, se corrigen (los de specs con test-writer, los de código con dev), se corre verify entero, porque la bandera exige el contenido actual, y se vuelve a esta skill. `review.js input` decide la ronda:
- **Ronda 1, completa:** el árbol entero, con el reviewer en opus.
- **Rondas 2 y 3, acotadas:** solo el diff de la corrección contra los bloqueantes de la ronda anterior, con su reporte como entrada, y el reviewer en sonnet. Si la corrección tocó archivos fuera del diff anterior, la ronda es completa y va en opus.
- **Tope: dos rondas de corrección.** Si mark dice `tope`, no corrijas más: reporta a la persona los bloqueantes que siguen y espera su decisión. `review.js input --completa` vuelve a la ronda 1; córrelo solo si la persona lo pide.

## Reporte

- **Riesgo:** si `review.js input` imprimió `REVISIÓN HUMANA OBLIGATORIA` en algún workspace, esa es la primera línea, con las rutas.
- **Los hallazgos, en el orden del reviewer:**
  - por archivo, primero los archivos con bloqueantes;
  - dentro de cada archivo, los bloqueantes antes que las sugerencias;
  - cada uno con su línea, su regla y cómo arreglarlo.
  Copia el texto del reviewer, no lo suavices ni lo reescribas.
- **Criterios:** la sección de cumplimiento de criterios si hubo plan, o la línea que dice que no lo hubo. En una ronda acotada, la de bloqueantes anteriores.
- **El cierre:** `BLOQUEANTES: <n>` y la ronda. Con bloqueantes, ship no entrega. Se corrige, se verifica y se revisa otra vez, hasta el tope.

Cierra con esta frase, literal: **Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.** La revisión tampoco certifica el negocio: busca lo que está en la lista cerrada.
