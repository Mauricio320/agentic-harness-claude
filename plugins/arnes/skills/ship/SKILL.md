---
name: ship
description: Entregar el cambio. Resuelve solo lo que falta (integrar los worktrees del issue, verificar, revisar) y se detiene únicamente con el gate en rojo, una revisión con bloqueantes o una zona de riesgo sin revisión humana. Commitea back antes que front con la convención del repo y, solo con confirmación explícita, hace push y abre los MR/PR cruzados. Con --solo-commit se detiene después de commitear.
argument-hint: "[--solo-commit] [--revisado <nombre>] [<rama>]"
disable-model-invocation: true
---

# arnes:ship

Argumentos: `$ARGUMENTS`. Con `--solo-commit` no hay push ni MR. `--revisado <nombre>` lo escribe la persona cuando alguien revisó una zona de riesgo. Otra palabra es el nombre de la rama.

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando `timeline.js` imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

## 1. Resolver lo que falta

1. Anota el inicio: `node "S/lib/timeline.js" start ship`.
2. Corre `node "S/ship.js" check`. Su salida va al informe de ship (abajo); en el chat, una línea.
   - **`LISTO`:** sigue con la rama. **`LISTO PARA SUBIR`:** no hay nada que commitear y la rama tiene commits sin subir: ve a la sección 4.
   - **`FALTA RESOLVER`:** resuelve cada línea, en su orden y sin preguntar, y vuelve a correr check:
     - `integrar <slug>`: `node "S/worktree-ledger.js" integrate <slug>`, y después la skill verify con `--base` en el primer padre del merge (`git -C "<carpeta>" rev-parse HEAD^1`).
     - `verificar <ws>`: carga la skill verify. Es barata si el contenido no cambió: reutiliza la foto del base, y los specs ya existen.
     - `revisar`: carga la skill review.
     Hasta tres vueltas. Si check sigue pidiendo lo mismo, dilo en una línea y termina.
   - **`SE DETIENE`:** es una de las tres razones para no entregar: el gate en rojo, bloqueantes o una zona de riesgo sin revisión humana. Copia en el chat, textual, el bloque que sigue a `para la persona:`, con lo que pasó en una o dos frases y los pasos numerados; nada más. Anota `end ship --result fail --detail "<la razón>"` y termina. Si la persona responde "corrígelo", corrige, verifica, revisa y vuelve a ship.

## 2. Rama

1. Elige el nombre, en este orden: la de `$ARGUMENTS`; la del issue (la línea `Rama:` de `.tmp/harness/plan.md`, que es la actual); la "rama propuesta" del check; una corta en kebab-case del título del plan o del pedido.
   - **En un worktree nativo de Claude Code**, la rama es la del worktree (en una carpeta, la de cada repo), y entregar es el push y el MR, no un merge local: `ship.js branch` la reutiliza.
2. Corre `node "S/ship.js" branch <rama>`. El prefijo del manifiesto se agrega solo. Si sale con 1, di el motivo y termina. Nunca muevas un HEAD a mano.

## 3. Commits, uno por workspace, en el orden del check (back antes que front)

1. **Stage:** `node "S/ship.js" stage <ws>`. Agrega solo los tocados y los borrados; lo que no debe entrar (`.env`, logs) se queda fuera, y lo dice. Nunca `git add .`.
2. **Mensaje**, con la convención del repo: commitlint si el check lo encontró (léelo); si no, el CLAUDE.md del repo; si no, la forma de los últimos asuntos del check, en su idioma. Asunto: qué cambia, no cómo. Cuerpo: el porqué, en pocas líneas. Si el check dice que la línea base cambia, el asunto empieza con `gates: `.
3. **Commit:** `git -C "<carpeta del workspace>" commit -m "<asunto>" -m "<cuerpo>"`. Si el guard lo niega, no lo rodees: di el motivo y termina.
4. **El commit:** `git -C "<carpeta>" log -1 --stat` va al informe; en el chat, el asunto y cuántos archivos.
5. **Comprueba lo commiteado:** `node "S/ship.js" committed <ws>`. Si sale con 1, un hook del repo cambió archivos después de verificar: di cuáles, anota `end ship --result fail --detail "el commit no es lo verificado"` y termina; decide la persona. Las notas (un archivo que quedó fuera, uno que solo cambió sus fines de línea) no son fallas: dilas y sigue.

**Con `--solo-commit`:** anota `end ship --result ok --detail "solo commit"`, di los commits en una línea por repo y termina.

## 4. Push y MR, solo con un sí explícito

1. **Pide confirmación** en un mensaje, antes de cualquier push o MR: la rama y, por repo, el commit y el remoto (`git -C <carpeta> remote get-url origin`); el título y el cuerpo de cada MR.
2. **Espera la respuesta.** Sin un sí explícito, anota `end ship --result ok --detail "commit sin push"` y termina.
3. **Push:** `git -C "<carpeta>" push -u origin <rama>`, back primero. Nunca `--force`.
4. **MR/PR:**
   - **El CLI:** `glab` si el remoto es GitLab y `gh` si es GitHub, cada uno solo si está instalado (`glab --version`, `gh --version`). Destino: la rama por defecto del manifiesto. Primero el del back.
   - **Enlaces cruzados:** el cuerpo del front enlaza el MR del back; después, edita el del back para que enlace el del front (`glab mr update <n> --description …` o `gh pr edit <n> --body …`).
   - **Cuerpo de cada MR:** qué cambia; los criterios del plan, si existe; la prueba manual del plan, si el check dice que la trae, con sus pasos numerados textuales; el resultado de verify, con la frase de abajo; la revisión, con sus bloqueantes en 0; los enlaces a los MR de los otros repos.
   - **Zona de riesgo:** si el check listó riskPaths tocadas, la primera línea del cuerpo es `REVISIÓN HUMANA OBLIGATORIA: <rutas>`.
   - **Sin glab ni gh:** muestra el enlace que imprimió el push y el cuerpo listo para pegar.
5. **Anota el fin:** `node "S/lib/timeline.js" end ship --result ok --detail "<MR o commits>"`.

## Reporte

Lo que lee la persona (docs/PLAN.md §2): una línea por repo con lo que se entregó, y lo que tiene que decidir o hacer. La confirmación del push y los MR es una sola pregunta, con todo lo que va a salir. Cuando ship se detiene, habla como una persona: el bloque de `para la persona:` y nada más, sin nombres de scripts ni códigos de salida. El detalle (la salida del check, `log --stat` de cada commit, los cuerpos de los MR) va al informe: `node "S/informe.js" path ship` da la ruta, y el chat la dice en una línea. La frase "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si informe.js dijo `frase: dila`; en el cuerpo de cada MR va siempre.
