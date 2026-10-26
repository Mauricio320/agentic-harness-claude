---
name: setup
description: Deja listo desde cero un proyecto ya adoptado a partir de su repo de carpeta. Clona la carpeta y sus repos en la rama declarada, instala dependencias, prepara el .env sin inventar valores, prueba los tests, revisa la línea base, arma el grafo y cierra con init --check y lo que queda pendiente de la persona. Con --check solo reporta.
argument-hint: "[--check] <url o ruta del repo de carpeta> [destino]"
disable-model-invocation: true
---

# arnes:setup

Argumentos: `$ARGUMENTS`. Con `--check` no se toca nada: corre cada paso sin `--write`, di en pocas líneas lo que haría y termina. Lo demás es la url o la ruta del repo de carpeta y, opcional, el destino.

El script es `${CLAUDE_PLUGIN_ROOT}/scripts/setup.js`; abajo, `S`. Córrelo con `node "S" <paso>` y la ruta entre comillas. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. Todo paso salvo clone lleva `--dir "<carpeta>"`, la carpeta del proyecto.

Quien lee no conoce el arnés (docs/PLAN.md §2): no le nombres scripts, pasos ni códigos de salida. Dile qué vas a hacer y dónde, en frases cortas.

Reglas:
- **Nunca corras un comando de `forbidden`** ni nada contra una base. Los comandos contra la base son de la persona.
- **Nunca escribas un valor en un `.env`** ni muestres uno: ni credenciales, ni tokens, ni contraseñas.
- **Lo que cambia algo de la persona** se hace solo con su sí, pedido en la única ronda de preguntas de abajo.

## 1. Lo que se hace sin preguntar

1. **El repo de carpeta:** `node "S" clone <fuente> [destino]`, y si dice "clonaría", lo mismo con `--write`: lo pidió la persona. Sin fuente, o si el destino ya tiene composición, usa esa carpeta. Si sale con 1, di el motivo y termina.
2. **La etapa:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start setup --dir "<carpeta>"`. La etapa dura el turno: si no la cierras, la cierra el Stop al terminarlo, y la configuración vuelve a quedar protegida.
3. **Los repos:** `node "S" repos --dir "<carpeta>" --write` clona los que faltan y hace fetch de los que existen. Un repo en otra rama no se mueve: va a la ronda.
4. **El entorno:** `node "S" env --dir "<carpeta>" --write` copia `.env.example` donde no hay `.env`. Anota las variables vacías, que llena la persona, y a qué host y puerto apunta cada conexión a base; si es local o un túnel, avisa que puede ser QA.
5. **Mirar lo demás, sin escribir:** `deps`, `baseline`, `graph`, `claude-md` y `permissions`, cada uno con `--dir "<carpeta>"` y sin `--write`.

## 2. Una sola ronda de preguntas

Un solo mensaje, con un bloque numerado. Cada punto dice qué se hace y dónde, con `Recomiendo:` y el porqué en una frase:
- **Cambiar de rama** un repo que está en otra que la que declara la composición (solo sin cambios sin commitear).
- **Instalar las dependencias** de cada repo, con el comando de su lockfile; tarda.
- **Capturar la línea base de tests** de un repo que no la tiene, después de instalar; commitearla es de la persona.
- **Armar el grafo** de cada repo, si graphify está instalado; si no, di dónde está la guía y sigue.
- **El CLAUDE.md de la carpeta**, si falta, y **los permisos** en `.claude/settings.local.json`, que no se commitea.

Cierra el bloque con: `Responde «sí a todo», o dime los números que cambias.` Termina el turno ahí.

## 3. Con la respuesta

Anota otra vez `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" start setup --dir "<carpeta>" --detail "respuesta"`: la etapa se cerró con el turno de la ronda. Aplica lo aceptado, en este orden y sin volver a preguntar: `repos --switch <ruta> --write`, `deps --write` (o `--repo <ruta>` por cada repo aceptado), `probe` (si dice FALTA por una dependencia, dilo), `baseline --ws <ws> --write`, `graph --write`, `claude-md --write` y `permissions --write`. Lo que la persona dijo que no, anótalo para el cierre.

## 4. El cierre

`node "S" close --dir "<carpeta>"` corre init --check y arma la lista "pendiente tuyo". El detalle de cada paso va al informe: `node "${CLAUDE_PLUGIN_ROOT}/scripts/informe.js" path setup --dir "<carpeta>"` da la ruta; escríbelo ahí con Write. En el chat, una línea con lo que quedó listo y la ruta del informe, y la lista "pendiente tuyo" en pocas líneas: los valores de `.env`, los comandos contra la base, un repo en otra rama, los permisos de la app que pida el issue y lo que la persona dijo que no. Anota `end setup --dir "<carpeta>" --result ok`.

Termina con: "Para trabajar, escribe tu pedido en lenguaje normal; el arnés planifica, construye, verifica y revisa solo, y al final pides /arnes:ship." Si informe.js dijo `frase: dila`, cierra con "Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio."

## Con --check

Corre clone, repos, deps, env, probe, baseline, graph, claude-md, permissions y close sin `--write` y sin preguntar. Si la carpeta todavía no existe, di qué clonaría y termina: lo demás no se puede correr. No modifiques ningún archivo.

setup es para un proyecto ya adoptado, con su repo de carpeta. Si la fuente no trae composición, dilo y sugiere `/arnes:init` para adoptarlo.
