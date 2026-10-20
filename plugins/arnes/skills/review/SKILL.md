---
name: review
description: Revisar el cambio antes de entregarlo o de abrir un MR. Lanza el reviewer del arnés una sola vez sobre el árbol final, con los tocados y el plan si existe; marca REVISIÓN HUMANA OBLIGATORIA si toca riskPaths y resume los hallazgos por archivo, bloqueantes primero.
---

# arnes:review

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta.

La revisión va después de verify, sobre el árbol que se va a entregar. Si cambias algo después, la revisión deja de valer y ship lo rechaza.

## Pasos

1. Anota el inicio: `node "S/lib/timeline.js" start review`.

2. Prepara la entrada: `node "S/review.js" input`.
   - **Qué deja:** `.tmp/harness/review/input.md`, con lo que el reviewer no puede sacar sin Bash: el HEAD de base, los tocados (los nuevos para leerlos enteros), los borrados, las riskPaths tocadas, el contrato, las reglas del repo y el diff contra HEAD.
   - **Qué imprime:** una línea por workspace, la ruta del plan o "no hay", y la ruta de `input.md`.
   - **Si dice que no hay nada que revisar:** anota `end review --result ok --detail "sin tocados"` y termina.

3. Lanza el agente `arnes:reviewer` **una sola vez**. El prompt lleva solo esto:
   ```
   Lee <ruta de input.md>. Plan: <ruta del plan, o "no hay plan">.
   ```
   - **No agregues tu opinión del cambio** ni un resumen de lo que hiciste: el reviewer juzga el árbol, no tu relato.
   - **No lo relances** para "confirmar" ni para que reconsidere un bloqueante.

4. Marca la revisión con el número de la última línea del reporte (`BLOQUEANTES: <n>`): `node "S/review.js" mark --blockers <n>`.
   - **Si el reporte no trae esa línea:** cuenta las líneas `BLOQUEANTE` del reporte.
   - **Si mark sale con 1:** el árbol cambió durante la revisión. Dilo, anota `end review --result fail --detail "el árbol cambió"` y termina.

5. Anota el fin: `node "S/lib/timeline.js" end review --result ok|fail --detail "<n> bloqueante(s)"`. Es `fail` si hay bloqueantes.

## Reporte

- **Riesgo:** si `review.js input` imprimió `REVISIÓN HUMANA OBLIGATORIA` en algún workspace, esa es la primera línea, con las rutas.
- **Los hallazgos, en el orden del reviewer:**
  - por archivo, primero los archivos con bloqueantes;
  - dentro de cada archivo, los bloqueantes antes que las sugerencias;
  - cada uno con su línea, su regla y cómo arreglarlo.
  Copia el texto del reviewer, no lo suavices ni lo reescribas.
- **Criterios:** la sección de cumplimiento de criterios si hubo plan, o la línea que dice que no lo hubo.
- **El cierre:** `BLOQUEANTES: <n>`. Con bloqueantes, ship no entrega. Se corrige, se verifica y se revisa otra vez.

Cierra con esta frase, literal: **Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.** La revisión tampoco certifica el negocio: busca lo que está en la lista cerrada.
