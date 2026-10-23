---
name: build
description: Implementar un plan aprobado de .tmp/harness/plan.md con un agente dev por workspace tocado, el back antes que el front; el contrato que devuelve el back viaja textual al front, y cada dev declara desviaciones y cobertura de criterios con archivo:línea. También levanta la app para probarla, y la para, cuando la persona lo pide ("inicia la app", "levanta la app", "para la app").
argument-hint: "[workspace]..."
---

# arnes:build

Argumentos: `$ARGUMENTS` (opcional: limita a esos workspaces).

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando un script imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

1. Lee `.tmp/harness/plan.md` en la raíz del proyecto. Si no existe, o no dice `Aprobado:`, o le quedan preguntas sin decidir, corre primero la skill plan. Build no decide por la persona.
2. Arma la lista de workspaces de `## Workspaces y orden`. El orden es back y después front: primero el que provee el contrato (`contract.provides`, o el que expone la API), después el que lo consume. Si dos workspaces no dependen uno del otro y tocan archivos disjuntos, pueden ir en paralelo en el mismo árbol.
3. Por cada workspace, en ese orden:
   - Si consume un contrato, guarda con Write la sección `## Contrato resultante` que devolvió el dev del back, textual, en `.tmp/harness/build/contrato.md`. No la resumas ni la reescribas: el front se escribe contra ese texto.
   - Arma su entrada: `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" input --ws <ws>`. Abre la etapa del workspace y deja `.tmp/harness/build/<ws>-input.md` con los comandos, las riskPaths, los forbidden, el comando de convenciones, el contrato si consume uno, el texto de las reglas que aplican a los archivos previstos y el plan en lo que toca a ese workspace.
   - **Si la entrada avisa que el plan regenera las dependencias enlazadas** (un worktree con node_modules del principal y un cambio en `regeneratesNodeModules`, como el schema de Prisma), dilo y pregunta antes de lanzar el dev si las instala adentro: con el sí, `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" deps --ws <ws> --write`. Con el no, sigue y anótalo en "pendiente tuyo".
   - Lanza un agente `arnes:dev`, uno por workspace, nunca uno para dos. Su prompt lleva solo el nombre del workspace, su carpeta absoluta, la ruta de su entrada y los criterios que le tocan. No le pegues el plan entero.
   - Cuando vuelve, comprueba que el reporte trae sus seis secciones y que cada criterio asignado aparece en `## Cobertura de criterios`, con `archivo:línea` o con `sin cubrir` y el motivo.
   - Abre dos o tres de las líneas citadas para comprobar que dicen lo que el dev afirma. Si un criterio falta, o una desviación contradice una decisión del plan, relanza el dev con la corrección concreta, una vez. Si sigue igual, repórtalo; no lo arregles tú en silencio.
   - Cierra el workspace: `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" end --ws <ws>`, con `--result parcial` si quedó algo sin cubrir. Cierra su etapa y dice qué correr después del build (paso 6); al cerrar el último, da la ruta del informe.
4. Worktrees solo si dos devs tocarían los mismos archivos a la vez (docs/PLAN.md §7). En ese caso, pídele a la persona `/arnes:worktree open <slug>`. Un dev en un worktree termina cuando su rama está integrada.
   - **El dev en un worktree** recibe en su prompt la carpeta del worktree y el mapa de puertos de su set (`worktree-ledger.js list`).
5. El reporte (docs/PLAN.md §2), sin nombres de scripts, códigos de salida ni rutas del plugin:
   - **El detalle va al informe:** la ruta es la línea `informe:` que dio `build.js end` del último workspace (la misma que da `node "${CLAUDE_PLUGIN_ROOT}/scripts/informe.js" path build`). Escribe ahí, por workspace y en el orden en que se construyó, el contrato resultante, los archivos tocados, las desviaciones del plan, la cobertura (C1… → `archivo:línea`, y los criterios sin cubrir) y los specs que faltan.
   - **En el chat:** una línea por workspace con lo que quedó hecho, la ruta del informe, y la lista corta de lo que le toca a la persona: los criterios sin cubrir, lo que afterBuild dejó pendiente y, si se tocaron `riskPaths`, `REVISIÓN HUMANA OBLIGATORIA` con los archivos.
6. **Después del build, solo en local:** lo dice `build.js end` de cada workspace.
   - Si lista comandos, la base del `.env` es la local: cámbiate a la carpeta del workspace con un `cd` aparte y corre cada comando listado, solo y tal como aparece. Dilo en una línea.
   - Si sale con 1, no corras nada: va a "pendiente tuyo", con el host y el puerto que dijo.
7. Cuando el último dev entrega y el reporte está escrito, no cierres el turno: carga la skill verify en el mismo turno. Los devs corren en segundo plano, así que ese momento llega cuando vuelve el último, aunque el turno se haya reabierto con su aviso. No escribas la bandera ni commitees: eso es de verify y ship.

## Levantar la app

Cuando la persona pide probarla ("inicia la app", "levanta la app"): `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" app --ws <ws>` por workspace, el back primero. La arranca desde la carpeta de la sesión, en segundo plano, y en un worktree con sus puertos en el entorno del proceso, que ganan a cualquier `.env`. Di en una línea en qué puerto quedó cada una y dónde mirar su salida. Cuando la persona pide pararla ("para la app"), `node "${CLAUDE_PLUGIN_ROOT}/scripts/build.js" app stop`: para solo lo que levantó el arnés, y lo dice. Nunca pares un proceso por tu cuenta, ni con otro comando.
