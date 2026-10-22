---
name: ship
description: Entregar el cambio verificado y revisado. Usa la misma rama en todos los workspaces tocados, commitea back antes que front con la convención del repo y, solo con confirmación explícita, hace push y abre los MR/PR cruzados. Con --solo-commit se detiene después de commitear.
argument-hint: "[--solo-commit] [<rama>]"
disable-model-invocation: true
---

# arnes:ship

Argumentos: `$ARGUMENTS`. Con `--solo-commit` no hay push ni MR. Si viene otra palabra, es el nombre de la rama.

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando `timeline.js` imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

## 1. Comprobar

1. Anota el inicio: `node "S/lib/timeline.js" start ship`.
2. Corre `node "S/ship.js" check`. Su salida va al informe de ship (abajo); en el chat, una línea con lo que encontró.
   - **Si sale con 1:** anota `end ship --result fail --detail "<motivo>"` y termina. Di qué falta: `/arnes:verify` si es la bandera, `/arnes:review` si es la revisión o tiene bloqueantes, `/arnes:worktree integrate <slug>` si son worktrees, o sacar del árbol un archivo que no debe entrar.
   - **Nunca verifiques ni revises desde aquí.**

## 2. Rama

1. Elige el nombre, en este orden:
   - la rama de `$ARGUMENTS`, si viene;
   - la rama del issue que creó plan al aprobar (la línea `Rama:` de `.tmp/harness/plan.md`), que es la actual: `ship.js branch` la reutiliza;
   - la "rama propuesta" del check;
   - una corta en kebab-case a partir del título de `.tmp/harness/plan.md` o del pedido de la persona.
2. Corre `node "S/worktree-ledger.js" pending --target <rama>`, con el prefijo incluido. Si sale con 1, di qué worktrees siguen abiertos, anota `end ship --result fail --detail "worktrees sin integrar"` y termina: falta `/arnes:worktree integrate <slug>`.
   - **En un worktree nativo de Claude Code**, la rama es la del worktree, y entregar es el push y el MR, no un merge local: `ship.js branch` la reutiliza.
3. Corre `node "S/ship.js" branch <rama>`. El prefijo del manifiesto se agrega solo. Si plan ya la creó, la reutiliza; crearla aquí queda solo para cuando nadie la creó antes.
4. Si sale con 1, muestra el motivo y termina. Nunca muevas un HEAD a mano.

## 3. Commits, uno por workspace, en el orden del check (back antes que front)

1. **Stage:** `node "S/ship.js" stage <ws>`. Agrega solo los tocados y los borrados. Nunca `git add .`.
2. **Mensaje**, con la convención del repo:
   - commitlint, si el check lo encontró (léelo);
   - si no, lo que diga el CLAUDE.md del repo;
   - si no, la forma de los últimos asuntos que imprime el check, en su idioma.
   - **Asunto:** qué cambia, no cómo.
   - **Cuerpo:** el porqué, en pocas líneas.
   - **Línea base:** si el check dice que la línea base cambia, el asunto empieza con `gates: `.
3. **Commit:** `git -C "<carpeta del workspace>" commit -m "<asunto>" -m "<cuerpo>"`. Si el guard lo niega, no lo rodees: di el motivo y termina.
4. **El commit:** `git -C "<carpeta>" log -1 --stat` va al informe; en el chat, el asunto y cuántos archivos.
5. **Comprueba lo commiteado:** `node "S/ship.js" committed <ws>`. Si sale con 1, un hook del repo cambió archivos después de verificar: di cuáles, anota `end ship --result fail --detail "el commit no es lo verificado"` y termina, sin otro workspace ni push. Decide la persona. Una nota `quedó sin commitear: <archivo>` no es una falla: dila y sigue.

**Con `--solo-commit`:** anota `end ship --result ok --detail "solo commit"`, di los commits creados en una línea por repo y termina.

## 4. Push y MR, solo con un sí explícito

1. **Pide confirmación** en un mensaje, antes de cualquier push o MR. Lista:
   - la rama y, por repo, el commit y el remoto (`git -C <carpeta> remote get-url origin`);
   - el título y el cuerpo de cada MR.
2. **Espera la respuesta.** Sin un sí explícito, anota `end ship --result ok --detail "commit sin push"` y termina.
3. **Push:** `git -C "<carpeta>" push -u origin <rama>`, back primero. Nunca `--force`.
4. **MR/PR:**
   - **El CLI:** `glab` si el remoto es GitLab y `gh` si es GitHub, cada uno solo si está instalado (`glab --version`, `gh --version`). Destino: la rama por defecto del manifiesto. Abre primero el del back.
   - **Enlaces cruzados:** el cuerpo del front enlaza el MR del back. Después, edita el del back para que enlace el del front (`glab mr update <n> --description …` o `gh pr edit <n> --body …`).
   - **Cuerpo de cada MR:**
     - qué cambia;
     - los criterios del plan, si existe;
     - el resultado de verify, con la frase de abajo;
     - la revisión, con sus bloqueantes en 0;
     - los enlaces a los MR de los otros repos.
   - **Zona de riesgo:** si el check listó riskPaths tocadas, la primera línea del cuerpo es `REVISIÓN HUMANA OBLIGATORIA: <rutas>`.
   - **Sin glab ni gh:** muestra el enlace que imprimió el push y el cuerpo listo para pegar.
5. **Anota el fin:** `node "S/lib/timeline.js" end ship --result ok --detail "<MR o commits>"`.

## Reporte

Lo que lee la persona (docs/PLAN.md §2): una línea por repo con lo que se entregó, y lo que tiene que decidir o hacer. La confirmación del push y los MR es una sola pregunta, con todo lo que va a salir. Sin nombres de scripts, códigos de salida, hashes completos ni rutas del plugin. El detalle (la salida del check, `log --stat` de cada commit, los cuerpos de los MR) va al informe: `node "S/informe.js" path ship` da la ruta, y el chat la dice en una línea. La frase "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si informe.js dijo `frase: dila`; en el cuerpo de cada MR va siempre.
