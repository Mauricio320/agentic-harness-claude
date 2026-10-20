# Prueba manual de la fase 2b: arnes-ui

Un mod solo se prueba de verdad en una sesión interactiva con el plugin cargado. Esta prueba se hace en `api-academico`, que es un campo de pruebas de solo lectura. El único archivo que se crea es `src/prueba-arnes.ts`, y el paso 8 lo borra. No se hace `git add` ni ningún commit.

La fase 2b se cierra cuando los pasos 1 a 7 salen como están escritos y lo confirmas.

## Qué necesita el panel según el ancho

- **Banda:** se ve a cualquier ancho. Es una sola línea, y lo que no cabe se corta al final.
- **Panel abierto por el mod al arrancar la sesión:** aparece solo si la terminal tiene 144 columnas o más. Con menos, espera sin dibujarse hasta que la terminal se ensancha o lo abres tú.
- **Panel abierto con `/arnes-panel`:** aparece a cualquier ancho.
  - En la vista de pantalla completa de Claude Code, desde 110 columnas, se acopla al lado del transcript.
  - Más angosto, o fuera de esa vista, se dibuja encima del prompt.
  - Cada línea del panel se corta al ancho del panel.

Para ver cuántas columnas tienes, en PowerShell: `$Host.UI.RawUI.WindowSize.Width`.

Los toasts dependen de la terminal: en la terminal embebida de Muxentra dentro de VS Code no se dibujan (ver Resultado). Haz los pasos 2 y 4 en una terminal normal fuera de VS Code, como Windows Terminal. Los avisos que importan salen además como línea tenue en el transcript, así que esa línea se ve en cualquier terminal.

## 0. Antes de abrir la sesión

En PowerShell, con la terminal a 144 columnas o más:

```powershell
cd C:\Users\MauricioTriana\Desktop\PDV\agentic-harness
git branch --show-current                         # feature/fase-2b-ui
cd C:\Users\MauricioTriana\Desktop\PDV\academico
Remove-Item .tmp\harness\gate\api-academico.json -ErrorAction SilentlyContinue   # bandera vieja de la fase 2
cd api-academico
git status --short                                # anota qué hay: los conteos del panel salen de aquí
$Host.UI.RawUI.WindowSize.Width                   # 144 o más
claude --plugin-dir "C:\Users\MauricioTriana\Desktop\PDV\agentic-harness\plugins\arnes" --plugin-dir "C:\Users\MauricioTriana\Desktop\PDV\agentic-harness\plugins\arnes-ui"
```

Dentro de la sesión, `/plugin` tiene que listar `arnes` y `arnes-ui` sin errores. Si el módulo del mod no cargó, el transcript muestra una línea tenue que empieza con `arnes-ui:` y dice por qué.

## 1. Al arrancar: banda, status y panel

Sin escribir nada todavía:
- **La banda sobre el prompt** dice, en gris: `arnes ▸ listo · academico-front · api-academico`. `academicoBitbuckett` no aparece porque no tiene manifiesto propio.
- **La status line** dice `⚠arnes-ui: listo`: el triángulo y el nombre del plugin los pone el motor.
- **El panel** se abre solo, con el título `arnes`. Su contenido es el del paso 3.

Mientras Claude responde cualquier prompt, la banda cambia `listo` por `Pensando…`, y vuelve a `listo` al terminar.

## 2. Editar un archivo, y el toast del Stop

Prompt:

> Crea `src/prueba-arnes.ts` con exactamente esta línea: `const noUsada = "x";`. No corrijas nada. Si el arnés te bloquea al terminar el turno, no verifiques ni escribas la bandera: di qué quedó sin verificar y termina.

Esperado:
1. **Después del Write** la banda termina en `api-academico ✎1`: un archivo editado en ese workspace.
2. **Al cerrar el turno, el Stop bloquea**, y en menos de 3 segundos aparece el aviso `arnes: el Stop bloqueó el turno · turno bloqueado sin verificar: api-academico (1 archivo(s) de código: src/prueba-arnes.ts; sin bandera de verificación para api-academico)`. Sale dos veces: como toast de `arnes-ui` arriba a la derecha durante 8 segundos, y como línea tenue en el transcript. Si el transcript se imprime en el scrollback, el toast es una línea en la barra de notificaciones. El aviso sale de la nota `bloqueado` que el stop-gate deja en la timeline, no de un hook en el Stop.
3. **El Stop suelta en el segundo intento** con su aviso, igual que en la fase 2. El mod no cambia nada de eso.

No hay toast de cambio de etapa: editar un archivo no es una etapa, solo suma al contador.

## 3. El panel con /arnes-panel

Escribe `/arnes-panel` dos veces. Si el panel estaba abierto, la primera vez dice `Panel del arnés cerrado.`. La segunda dice `Panel del arnés abierto.` y lo muestra con estas secciones:

```
arnes · academico · listo
Cronología
  sin etapas en esta corrida
Agentes
  ninguno
Gate
  academico-front · main · N cambio(s), 0 de código · tsc – · tests – · review – · sin bandera · ✎0
  api-academico · <rama> · N cambio(s), 1 de código · tsc – · tests – · review – · sin bandera · ✎1
Timeline
  hace … · stop-gate nota pendiente · turno cerrado sin verificar: api-academico (1 archivo(s) de código: …
Lo que sigue: falta verificar api-academico (1 archivo(s) de código)
```

- `N` es lo que mostró `git status` en el paso 0, más `src/prueba-arnes.ts` en api-academico.
- `de código` cuenta solo `.ts`, `.tsx`, `.js`, `.jsx`, `.php` y `.sql`.
- La rama de api-academico es la que tenga en ese momento.
- La timeline muestra las cinco notas más recientes, las de la fase 2 incluidas.

## 4. Una verificación: etapa, tiempo y resultado

Prompt:

> Ejecuta exactamente `npx tsc --noEmit` y dime solo si salió con errores.

Esperado:
1. **Al lanzar el comando:**
   - Toast `arnes ▸ Verificando (tsc api-academico)`.
   - La status line dice `⚠arnes-ui: Verificando (tsc api-academico)`.
   - La banda dice `arnes ▸ Verificando (tsc api-academico) 00:03 · academico-front · api-academico ⏳tsc ✎1`. El tiempo avanza cada 3 segundos mientras tsc corre.
2. **Al terminar tsc**, la marca pasa a `✓tsc` o `✗tsc`, según el resultado. Con errores aparece además el aviso `arnes: gate en rojo: ✗ tsc api-academico`, como toast y como línea en el transcript.
3. **Al cerrar el turno**, el transcript muestra una línea tenue como `arnes · corrida: Verificando 1m · más lenta: Verificando · más cara: Verificando ($0.04)`, con los minutos y el costo reales. El Stop vuelve a bloquear una vez, con su aviso.
4. **En el panel**, la cronología vuelve a `sin etapas en esta corrida`, y debajo aparece `promedio de 1 corrida(s): Verificando 1m $0.04`. La fila de api-academico dice `tsc ✓` o `tsc ✗`.

## 5. La bandera, leída del archivo

Escribe la bandera a mano en otra terminal:

```powershell
node "C:/Users/MauricioTriana/Desktop/PDV/agentic-harness/plugins/arnes/scripts/gate-flag.js" write api-academico --result pass
```

Esperado, en 3 segundos y sin escribir nada en la sesión:
- La banda termina en `api-academico ✓tsc ✎1 ✓flag`, o con `✗tsc` si tsc falló.
- En el panel la fila dice `bandera pass hace 3s`.
- `Lo que sigue` pasa a `verificado: listo para commit`. Si tsc falló, dice `corregir y volver a verificar api-academico`.

Después, cambia a mano el contenido de `src/prueba-arnes.ts` (por ejemplo, agrega una línea en blanco):
- En 15 segundos como máximo la banda pasa de `✓flag` a `flag vencida`, aunque el cambio no haya pasado por Claude.
- `node ".../gate-flag.js" check api-academico` sale con 1 y dice `el contenido de un archivo tocado cambió desde la verificación`.

Lo que el mod llama vigente es "menos de 30 minutos, mismo HEAD y ningún archivo cambiado modificado después". La vigencia exacta, con la lista de tocados, la siguen juzgando el guard y el Stop (`docs/PLAN.md` §3).

## 6. Un agente vivo y el botón ver

Prompt:

> Lanza un subagente de tipo Explore que cuente los archivos de `src/auth` y te devuelva solo el número.

Esperado:
1. **Mientras el agente corre**, la banda muestra `Explore <modelo> 00:0X` después de la etapa: `<modelo>` es `haiku`, `sonnet` u `opus`, según el que use.
2. **En el panel, bajo Agentes**, aparece la misma fila, con la última herramienta que usó, y un botón `[ ver ]` al lado.
3. **Para pulsarlo:**
   - Dale el foco al panel con ctrl+x y después Tab, o con un clic en pantalla completa.
   - Llega al botón con Tab y pulsa Enter.
   - La vista principal cambia al transcript del agente, y en el panel aparece `[ volver a la conversación ]`, que te devuelve.
   - Esc devuelve el foco al prompt.
4. **Cuando el agente termina**, sale de la banda. En el panel su fila queda en gris, con los tokens que gastó.

Explore no es un agente del arnés, así que no cambia la etapa. Los del arnés (`arnes:dev`, `arnes:reviewer`, `arnes:test-writer`) llegan en la fase 3.

## 7. Terminal angosta, y el mod desactivado

1. **Achica la terminal a unas 90 columnas:**
   - La banda sigue en una línea y se corta al final.
   - El panel que abriste con `/arnes-panel` sigue a la vista, encima del prompt, con cada línea cortada.
   - Ciérralo con `/arnes-panel`.
2. **Sal de la sesión, deja la terminal en 90 columnas y vuelve a abrirla con los dos `--plugin-dir`:**
   - La banda y la status line aparecen igual.
   - El panel no se abre solo.
   - `/arnes-panel` lo abre igual.
3. **Sal y abre una sesión solo con el plugin base:**
   ```powershell
   claude --plugin-dir "C:\Users\MauricioTriana\Desktop\PDV\agentic-harness\plugins\arnes"
   ```
   - No hay banda, ni status de `arnes`, ni toasts de `arnes-ui`, y `/arnes-panel` no existe.
   - Los hooks del plugin base se comportan como en la fase 2.
   - `/arnes:timeline` imprime la timeline en un bloque de código, con una línea por evento en hora local, por ejemplo `2026-10-19 17:51:39 stop-gate      nota pendiente · turno cerrado sin verificar: …`.

## 8. Limpieza

Prompt, o a mano:

> Borra `src/prueba-arnes.ts`.

Después, en PowerShell:

```powershell
cd C:\Users\MauricioTriana\Desktop\PDV\academico\api-academico
git status --short          # otra vez lo mismo que en el paso 0
Remove-Item ..\.tmp\harness\gate\api-academico.json -ErrorAction SilentlyContinue
```

El mod no escribe nada en el proyecto. Las corridas quedan en su `$.store`, un archivo propio dentro de la configuración de Claude Code, y la timeline es la del plugin base.

## Qué reportar

Por cada paso, di si salió como está escrito, y si no, copia el texto exacto que viste. No son fallos:
- una diferencia en ramas o en conteos de archivos por cambios previos;
- tiempos o costos distintos de los ejemplos.

Sí son fallos:
- que falte la banda o el panel;
- que un aviso de los pasos 2 y 4 no aparezca en el transcript; si se ve en el transcript y no como toast, di en qué terminal;
- que el botón ver no cambie la vista;
- que con el mod desactivado cambie algo del plugin base.

## Resultado

2026-10-19, con Claude Code 2.1.304, en `api-academico` y también desde la raíz de academico.

Salieron como están escritos:
- El paso 1: banda, status y panel al arrancar.
- El paso 3: `/arnes-panel` cierra y abre.
- El paso 4: la etapa Verificando con su tiempo y `✓tsc`, la línea de resumen de la corrida (54 segundos y 0,07 dólares) y el promedio en el panel.
- El paso 5: la bandera leída del archivo en 3 segundos, con `✓flag` y `Lo que sigue` en listo para commit.
- El paso 6: el agente Explore en la banda y en el panel, con su herramienta y sus tokens. El botón ver cambió la vista al agente, y volvió.
- El paso 7: en terminal angosta, la banda cortada y el panel encima del prompt, y el panel no se abre solo por debajo de 144 columnas.
- Desde la raíz, `git -C api-academico commit --dry-run` con bandera vigente pasó el guard.

Fallos y hallazgos, por orden de importancia:
1. **No se vio ningún toast** en la terminal embebida de Muxentra dentro de VS Code: ni el del Stop ni el de Verificando.
   - El del Stop no se levantó nunca. El transcript dijo `arnes-ui: its classic.Stop hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.`
   - El de Verificando sale del mismo `tool.call` que sí movió la banda: el hook corrió, y lo que no se dibuja es el toast.
   - Corregido sin depender del orden de la cadena: el stop-gate anota cada bloqueo en la timeline (nota `bloqueado`), y el mod levanta el aviso al leerla con su reloj. Los avisos importantes van además al transcript con `$.ui.log`. No pude comprobar el toast en una terminal normal desde la sesión de desarrollo: queda para la repetición del paso 2.
2. **Brecha de la bandera.** Tras cambiar el contenido de `src/prueba-arnes.ts`, ya tocado al escribir la bandera, `gate-flag check` seguía diciendo vigente. `touchedHash` cubría la lista de tocados pero no su contenido. Corregido con `contentHash`: el hash del contenido de cada tocado, trackeado o no. No es la huella del árbol entero (§11).
3. **Desde la raíz**, tras esa edición la banda no mostró `✎1` ni soltó el `✓flag`. Con un Edit o un Write por ruta absoluta o relativa desde la raíz, el test cuenta la edición en su workspace. La causa más probable es que la edición no pasó por Edit ni por Write. Corregido: cualquier modificación de un archivo cambiado después de la bandera la vence, porque el mod compara la fecha de modificación de lo que lista git, y git se relee cada 15 segundos. Una ruta relativa ahora se resuelve contra el cwd.
4. **La timeline mostró `hace 0s`** en todas las notas en el primer dibujo. Corregido: `now` se fija con la primera lectura, no en la primera vuelta del reloj.
5. **La status line mostraba `⚠arnes-ui: arnes · listo`.** El triángulo y `arnes-ui:` los pone el motor al dibujar el estado de un plugin; el mod solo pasaba `arnes · listo`. Ahora pasa `listo`, que se ve como `⚠arnes-ui: listo`. Queda en `docs/PLAN.md` §3.

Pendiente: repetir los pasos 2 y 4 por los avisos, y el paso 7.3, con el plugin base solo, que no se hizo. La fase 2b no se cierra hasta esa repetición.
