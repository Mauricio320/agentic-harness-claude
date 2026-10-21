---
name: setup
description: Deja listo desde cero un proyecto ya adoptado a partir de su repo de carpeta. Clona la carpeta y sus repos en la rama declarada, instala dependencias, prepara el .env sin inventar valores, prueba los tests, revisa la línea base, arma el grafo y cierra con init --check y lo que queda pendiente de la persona. Con --check solo reporta.
argument-hint: "[--check] <url o ruta del repo de carpeta> [destino]"
disable-model-invocation: true
---

# arnes:setup

Argumentos: `$ARGUMENTS`. Con `--check` no se toca nada: corre cada paso sin `--write`, muestra lo que haría y termina. Lo demás es la url o la ruta del repo de carpeta y, opcional, el destino.

El script es `${CLAUDE_PLUGIN_ROOT}/scripts/setup.js`; abajo, `S`. Córrelo con `node "S" <paso>` y la ruta entre comillas. Corre cada comando solo, sin `&&`, `;` ni `echo`: el código de salida ya lo da la herramienta, y un comando encadenado pide permiso aparte. Cada paso, antes de correrlo, dilo en una línea: qué hace y por qué. Muestra su salida tal cual.

Reglas:
- **Nunca corras un comando de `forbidden`** ni nada contra una base. Los comandos contra la base son de la persona.
- **Nunca escribas un valor en un `.env`** ni muestres uno: ni credenciales, ni tokens, ni contraseñas.
- **Un paso que dice qué haría** (sin `--write`) y que cambia algo se corre con `--write` solo después del sí que se indica. Si la persona dice no, sigue con el próximo paso y anótalo para el cierre.
- **Todo paso salvo clone** lleva `--dir "<carpeta>"`, la carpeta del proyecto.

## Pasos, en orden

1. **Repo de carpeta:** `node "S" clone <fuente> [destino]`.
   - Sin fuente, o si el destino ya tiene composición, usa esa carpeta y dilo.
   - Si dice "clonaría", corre lo mismo con `--write`. Clonar no necesita confirmación: lo pidió la persona.
   - Si sale con 1, explica el motivo y termina.
2. **Repos de la composición:** `node "S" repos --dir "<carpeta>"`, y después con `--write`: clona los que faltan y hace fetch de los que existen.
   - **Un repo en otra rama:** di en cuál está y cuál declara la composición, y pregunta si lo cambias. Solo con un sí, `repos --switch <ruta> --write`. Con cambios sin commitear no se mueve.
3. **Dependencias:** `node "S" deps --dir "<carpeta>"` lista el comando de cada repo según su lockfile.
   - **Pregunta antes,** en un mensaje con todos los comandos: tarda.
   - Con el sí, `deps --write`, o `--repo <ruta>` por cada repo aceptado.
4. **Entorno:** `node "S" env --dir "<carpeta>" --write`. Copia `.env.example` donde no hay `.env`.
   - Lista las variables vacías: las llena la persona.
   - Di a qué host apunta cada conexión a base. Si es local o un túnel, avisa que puede ser QA.
5. **Tests:** `node "S" probe --dir "<carpeta>"`. Si dice FALTA por una dependencia, dilo: es del paso 3.
6. **Línea base:** `node "S" baseline --dir "<carpeta>"`.
   - **Si falta,** ofrece capturarla. Con el sí, `baseline --ws <ws> --write`.
   - **Commitearla,** con `gates:` en el asunto, es de la persona.
7. **Grafo:** `node "S" graph --dir "<carpeta>"`. Con graphify instalado, corre lo mismo con `--write`. Sin él, di cómo instalarlo y sigue.
8. **CLAUDE.md de la carpeta:** `node "S" claude-md --dir "<carpeta>"`. Si falta, con el sí, `--write`.
9. **Permisos:** `node "S" permissions --dir "<carpeta>"`. Con el sí, `--write`: van a `.claude/settings.local.json`, que no se commitea.
10. **Cierre:** `node "S" close --dir "<carpeta>"`.
    - Corre init --check e imprime la lista "pendiente tuyo".
    - Muéstrala tal cual y suma lo que la persona dijo que no en los pasos de arriba.

## Con --check

Corre los pasos 1 a 10 sin `--write` y sin preguntar. Si la carpeta todavía no existe, el paso 1 dice qué clonaría, y los demás no se pueden correr: dilo y termina. No modifiques ningún archivo.

## Para un proyecto sin manifiesto

setup es para un proyecto ya adoptado, con su repo de carpeta. Si la fuente no trae composición, dilo y sugiere `/arnes:init` para adoptarlo.

El verde del arnés significa que cumple convenciones y compila/testea, nunca que sea correcto en el negocio.
