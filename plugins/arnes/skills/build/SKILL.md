---
name: build
description: Implementar un plan aprobado de .tmp/harness/plan.md con un agente dev por workspace tocado, el back antes que el front; el contrato que devuelve el back viaja textual al front, y cada dev declara desviaciones y cobertura de criterios con archivo:línea.
argument-hint: "[workspace]..."
---

# arnes:build

Argumentos: `$ARGUMENTS` (opcional: limita a esos workspaces).

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas.

1. Lee `.tmp/harness/plan.md` en la raíz del proyecto (`node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/manifest.js" show`). Si no existe, o no dice `Aprobado:`, o le quedan preguntas sin decidir, corre primero la skill plan. Build no decide por la persona.
2. Arma la lista de workspaces de `## Workspaces y orden`. El orden es back y después front: primero el que provee el contrato (`contract.provides`, o el que expone la API), después el que lo consume. Si dos workspaces no dependen uno del otro y tocan archivos disjuntos, pueden ir en paralelo en el mismo árbol.
3. Por cada workspace, en ese orden:
   - Anota el inicio: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start build --ws <ws>`.
   - Lanza un agente `arnes:dev`, uno por workspace, nunca uno para dos. Su prompt lleva, en este orden:
     - El nombre del workspace y su carpeta absoluta.
     - El plan entero, pegado tal cual.
     - Los criterios que le tocan a ese workspace.
     - Si consume un contrato, la sección `## Contrato resultante` que devolvió el dev del back, copiada textual entre las líneas `--- contrato del back ---` y `--- fin del contrato ---`. No la resumas ni la reescribas: el front se escribe contra ese texto.
   - Cuando vuelve, comprueba que el reporte trae sus seis secciones y que cada criterio asignado aparece en `## Cobertura de criterios`, con `archivo:línea` o con `sin cubrir` y el motivo.
   - Abre dos o tres de las líneas citadas para comprobar que dicen lo que el dev afirma. Si un criterio falta, o una desviación contradice una decisión del plan, relanza el dev con la corrección concreta, una vez. Si sigue igual, repórtalo; no lo arregles tú en silencio.
   - Anota el fin: `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" end build --ws <ws> --result ok`, o `--result parcial` si quedó algo sin cubrir.
4. Worktrees solo si dos devs tocarían los mismos archivos a la vez (docs/PLAN.md §7). En ese caso, pídele a la persona `/arnes:worktree open <slug>`. Un dev en un worktree termina cuando su rama está integrada.
5. Reporta a la persona, por workspace y en el orden en que se construyó:
   - El contrato resultante.
   - Los archivos tocados.
   - Las desviaciones del plan.
   - La cobertura: C1… → `archivo:línea`, y los criterios sin cubrir.
   - Los specs que faltan.
   - Si se tocaron `riskPaths`, escribe `REVISIÓN HUMANA OBLIGATORIA` con los archivos.
6. Cierra con la frase: "Construido, sin verificar. Sigue verify." No escribas la bandera ni commitees: eso es de verify y ship. El verde del arnés, cuando llegue, significa que compila y testea, nunca que sea correcto en el negocio.
