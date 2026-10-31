---
name: ship
description: Entregar el cambio. Resuelve solo lo que falta (integrar los worktrees del issue, verificar, revisar) y se detiene únicamente con el gate en rojo, una revisión con bloqueantes o una zona de riesgo sin revisión humana. Commitea back antes que front con la convención del repo y, solo con confirmación explícita, hace push y abre los MR/PR cruzados. Con --solo-commit se detiene después de commitear.
argument-hint: "[--solo-commit] [--revisado <nombre>] [<rama>]"
disable-model-invocation: true
---

# arnes:ship

Argumentos: `$ARGUMENTS`. Con `--solo-commit` no hay push ni MR. `--revisado <nombre>` lo escribe la persona cuando alguien revisó una zona de riesgo. Otra palabra es el nombre de la rama.

Los scripts viven en `${CLAUDE_PLUGIN_ROOT}/scripts`. Córrelos con `node` y la ruta entre comillas, desde el directorio donde se abrió la sesión. Abajo, `S` es esa carpeta. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. La lista de tareas de la sesión (docs/PLAN.md §6.3): cuando un script imprime `tareas: [...]`, pásale esa lista a TodoWrite si la sesión lo tiene (con TaskCreate y TaskUpdate, el mismo estado); si no tiene ninguna, sigue sin ella.

Cada transición de ship es una llamada a `node "S/ship.js" deliver`, que anota la etapa, deja el detalle en el informe de la entrega y dice qué sigue.

## 1. Comprobar y preparar

Corre `node "S/ship.js" deliver`, con `--solo-commit` y `--rama <rama>` si vienen en `$ARGUMENTS`.
- **`FALTA RESOLVER`:** resuelve cada línea, en su orden y sin preguntar, y vuelve a correr `deliver`:
  - `integrar <nombre>`: `node "S/worktree-ledger.js" integrate <nombre>`, el worktree de un dev aislado que quedó sin integrar, y después la skill verify con `--base` en el primer padre del merge (`git -C "<carpeta>" rev-parse HEAD^1`).
  - `verificar <ws>`: carga la skill verify. Es barata si el contenido no cambió: reutiliza la foto del base, y los specs ya existen.
  - `revisar`: carga la skill review.
  Hasta tres vueltas. Si sigue pidiendo lo mismo, dilo en una línea y termina.
- **`SE DETIENE`:** es una de las tres razones para no entregar: el gate en rojo, bloqueantes o una zona de riesgo sin revisión humana. Copia en el chat, textual, el bloque que sigue a `para la persona:`, con lo que pasó en una o dos frases y los pasos numerados; nada más. La etapa ya quedó cerrada. Si la salida trae líneas `regla propuesta: <ws> · <manifiesto> · <regla>`, antes de terminar corre `node "S/ajuste.js" propone --archivo <manifiesto> --detalle "convenciones nuevas: <los id>"` una vez por manifiesto. Si la persona responde "corrígelo", con reglas propuestas corre primero `node "S/ajuste.js" aprueba` y agrega cada regla tal cual al `conventions` de su manifiesto con Edit; con "corrígelo sin reglas", no. Después corrige, verifica, revisa y vuelve a ship.
- **`LISTO`:** `deliver` ya dejó la rama (la del issue, la actual; en un worktree nativo, la del worktree) y el stage de cada workspace, en el orden de commit (back antes que front); lo que no debe entrar (`.env`, logs) quedó fuera, y lo dice; la configuración del proyecto (`.claude/harness.json`, `settings*.json`, `rules/`, `hooks/`) también: díselo a la persona en una línea, porque la commitea ella si la quiere. Sigue con los mensajes.
- **`LISTO PARA SUBIR`:** no hay nada que commitear y la rama tiene commits sin subir: ve a la sección 3. **`LISTO PARA MERGEAR`:** ve al merge local.

## 2. Mensajes y commits

1. **Los mensajes**, con la convención del repo que mostró `deliver`: commitlint si lo encontró (léelo); si no, el CLAUDE.md del repo; si no, la forma de los últimos asuntos, en su idioma. Asunto: qué cambia, no cómo. Cuerpo: el porqué, en pocas líneas. Si dijo que la línea base de tests cambia, el asunto empieza con `gates: `. Sin `--solo-commit`, agrega a cada uno su `mr`: un título y una descripción corta de qué cambia; el resto del cuerpo del MR lo arma el arnés.
2. Escríbelos con Write en `.tmp/harness/ship/mensajes.json`, como dijo `deliver`: `{ "<ws>": { "asunto": "…", "cuerpo": "…", "mr": { "titulo": "…", "descripcion": "…" } } }`.
3. Corre `node "S/ship.js" deliver --commit`. Commitea cada workspace en su orden, solo con su verificación vigente; comprueba que cada commit lleva lo verificado, y deja en el informe el `log --stat` de cada uno. Si dice `FALLA`, di en una línea lo que pasó (sin verificación vigente, un hook del repo que rechazó el commit, o archivos que cambió después de verificar) y termina: la etapa ya quedó cerrada, y decide la persona. Las notas (un archivo que quedó fuera, uno que solo cambió sus fines de línea) no son fallas: dilas.

**Con `--solo-commit`:** `deliver --commit` cierra la etapa; di los commits en una línea por repo y termina.

**Con merge local** (`deliver` dice `entrega: merge local`, para quien trabaja solo y sin QA), en vez de la sección 3: `node "S/ship.js" merge start` mergea la rama del issue sobre la por defecto sin moverla; carga verify con `--base HEAD^1`. En verde, `merge finish` adelanta la rama por defecto; en rojo, `merge abort` y para con el bloque de la persona. Si start o finish dicen `SE DETIENE`, copia su bloque y termina. Después, con un sí explícito, `git -C "<carpeta>" push origin <rama por defecto>`, y cierra la etapa con `node "S/lib/timeline.js" end ship --result ok --detail "merge local"`.

## 3. Push y MR, solo con un sí explícito

1. **Pide confirmación** en un solo mensaje, antes de cualquier push o MR: la rama y, por repo, el commit y el remoto que dio `deliver --commit`, el título de cada MR (los cuerpos están en el informe) y cada línea `aviso:` de la comprobación, en palabras simples. Termina el turno ahí: el push exige una respuesta de la persona después del commit.
2. **Con el sí:** `node "S/ship.js" deliver --push`. Sube cada repo, back primero y nunca con `--force`; abre cada MR con glab o gh si están, con `REVISIÓN HUMANA OBLIGATORIA` primero si hay riskPaths, los criterios y la prueba manual del plan, el resultado de verify con la frase y la revisión, y enlaza los MR de los otros repos. Sin glab ni gh, los cuerpos quedan en el informe para pegar: dilo y muestra el enlace que dio el push. Deja el issue subido y cierra la etapa. Cuando el MR se mergee, la persona lo cierra con `/arnes:cerrar <issue>`.
3. **Sin el sí:** `node "S/ship.js" deliver --sin-push`.
4. **Lo que se creó para el issue:** `deliver --push` lo lista con su tamaño. Pregunta en una línea: "¿Borro lo que creé para este issue, o lo dejo?", con esa lista. Con el sí, `node "S/issues.js" clean --actual --write`: borra solo lo registrado, en orden seguro, y deja la rama del issue hasta que el MR esté mergeado; si dice que falta el worktree de esta sesión, sal de él con ExitWorktree y `action: "remove"`. Con "lo dejo", queda, y `/arnes:cerrar` lo hace después.

## Reporte

Lo que lee la persona (docs/PLAN.md §2): una línea por repo con lo que se entregó, y lo que tiene que decidir o hacer. La confirmación del push y los MR es una sola pregunta, con todo lo que va a salir. Cuando ship se detiene, habla como una persona: el bloque de `para la persona:` y nada más, sin nombres de scripts ni códigos de salida. El detalle (la salida de la comprobación, el `log --stat` de cada commit, los cuerpos de los MR) ya está en el informe de la entrega, que `deliver` dice en su línea `informe:` (la carpeta de `node "S/informe.js" path ship`); el chat la dice en una línea. La frase "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio." va al final solo si la salida dijo `frase: dila`; en el cuerpo de cada MR va siempre.
