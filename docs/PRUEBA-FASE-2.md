# Prueba manual de la fase 2: hooks clásicos

Los hooks solo se prueban de verdad en una sesión interactiva con el plugin cargado. Esta prueba se hace en `api-academico`, que es un campo de pruebas de solo lectura. El único archivo que se crea es `src/prueba-arnes.ts`, y el paso 7 lo borra. No se hace `git add` ni ningún commit.

La fase 2 se cierra cuando los pasos 1 a 5 salen como están escritos y lo confirmas.

## 0. Antes de abrir la sesión

En PowerShell:

```powershell
cd C:\Users\MauricioTriana\Desktop\PDV\agentic-harness
git branch --show-current                        # feature/fase-2-hooks
cd C:\Users\MauricioTriana\Desktop\PDV\academico
Test-Path .claude\harness.json                    # True: la composición de academico
Test-Path .tmp\harness\gate\api-academico.json    # False: no hay bandera previa
cd api-academico
git status --short                                # ?? .claude/harness.json, y nada más
claude --plugin-dir "C:\Users\MauricioTriana\Desktop\PDV\agentic-harness\plugins\arnes"
```

Si `api-academico` muestra otros cambios, anótalos antes de seguir: van a aparecer en los conteos de los pasos 1 y 3.

Dentro de la sesión, `/hooks` tiene que listar los hooks del plugin:
- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse` con `Bash|PowerShell`, y otro con `ExitWorktree`
- `PostToolUse` con `Edit|Write`
- `Stop`

## 1. SessionStart: contexto al abrir

Prompt:

> Sin usar herramientas, copia literal el contexto que te inyectó el arnés al iniciar la sesión.

Esperado, en 40 líneas o menos:

```
arnes · academico · carpeta con 3 repo(s) · raíz C:\Users\MauricioTriana\Desktop\PDV\academico
- academico-front (academico-front) · rama main · 1 archivo(s) sin commitear · nextjs · sin riskPaths
- academico-bitbuckett (academicoBitbuckett) · rama master · no adoptable todavía: sin manifiesto propio, no se verifica
- api-academico (api-academico) · rama feature/colegio-convenio-permissions · 1 archivo(s) sin commitear · nestjs-prisma · sin riskPaths
Protocolo del arnés:
1. Manda el manifiesto de cada repo: …
…
6. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio. Repórtalo así.
Scripts: node "C:/Users/MauricioTriana/Desktop/PDV/agentic-harness/plugins/arnes/scripts/<script>.js" --help
```

Las ramas y los conteos son los del momento de la prueba. Al terminar este turno no hay código tocado, así que el Stop no dice nada.

## 2. PostToolUse: lint del archivo editado, y Stop con un solo bloqueo

Prompt:

> Crea `src/prueba-arnes.ts` con exactamente esta línea: `const noUsada = "x";`. No corrijas nada. Después dime literalmente qué contexto te devolvió el arnés tras escribir el archivo. Si el arnés te bloquea al terminar el turno, no verifiques ni escribas la bandera: di qué quedó sin verificar y termina.

Esperado:
1. **Mientras corre el hook:** aparece `arnes: lint del archivo editado`. ESLint con tipos tarda varios segundos.
2. **El contexto del lint:** Claude cita un texto que empieza con `arnes · lint de src/prueba-arnes.ts en api-academico (exit 1):`. Debajo vienen los errores de ESLint de esa sola línea: al menos `@typescript-eslint/no-unused-vars` (`'noUsada' is assigned a value but never used`) y `prettier/prettier` (`Replace "x" with 'x'`). Si en vez de eso aparece `was not found by the project service`, el hook funcionó y el hallazgo es del tsconfig del repo; anótalo.
3. **El Stop bloquea una vez:** al intentar cerrar el turno, el transcript muestra el hook `Stop` con un motivo que empieza con `arnes: hay cambios de código sin verificación vigente en api-academico (1 archivo(s) de código: src/prueba-arnes.ts; sin bandera de verificación para api-academico)` y termina con `este bloqueo ocurre una sola vez por turno`.
4. **Claude responde al bloqueo** diciendo qué quedó sin verificar. Al intentar cerrar de nuevo, el Stop deja pasar y muestra el aviso visible `arnes: el turno termina con cambios sin verificar en api-academico (…). Quedó anotado en la timeline.`
5. **Queda una nota en la timeline:** `C:\Users\MauricioTriana\Desktop\PDV\academico\.tmp\harness\timeline.jsonl` tiene una línea con `"event":"note","stage":"stop-gate","result":"pendiente"`.

## 3. UserPromptSubmit: estado del gate en cada prompt

Prompt:

> Copia literal el estado que te adjuntó el arnés con este mensaje.

Esperado:

```
arnes · api-academico: 2 tocado(s), 1 de código · bandera no vigente (sin bandera de verificación para api-academico)
```

Los dos tocados son `.claude/harness.json` y `src/prueba-arnes.ts`; solo el segundo es código. Al cerrar el turno, el Stop vuelve a bloquear una vez y después deja pasar, igual que en el paso 2: es un bloqueo por turno mientras haya código sin verificar.

## 4. PreToolUse: git commit sin bandera, denegado

Prompt:

> Ejecuta exactamente `git commit -m "prueba arnes"`, sin `git add` y sin intentar rodear el bloqueo.

Esperado:
- **La llamada se deniega antes de correr**, con el motivo `arnes guard: git commit en api-academico sin bandera de verificación vigente: sin bandera de verificación para api-academico. Verifica (typecheck, lint de los tocados, specs de test-select) y escribe la bandera con node "C:/Users/MauricioTriana/Desktop/PDV/agentic-harness/plugins/arnes/scripts/gate-flag.js" write api-academico --result pass|fail.`
- **`git log -1` no cambia.**

Opcional, para ver que el guard no mira texto libre:

> Ejecuta exactamente `echo "git commit -m x && git reset --hard"`.

Esperado: corre e imprime el texto, sin denegación.

## 5. Con bandera vigente, el commit pasa

Escribe la bandera a mano: es la persona quien la escribe, no la verificación. Después pide a Claude un commit en seco, que no crea nada:

```powershell
node "C:/Users/MauricioTriana/Desktop/PDV/agentic-harness/plugins/arnes/scripts/gate-flag.js" write api-academico --result pass
```

Prompt:

> Ejecuta exactamente `git commit --dry-run -m "prueba arnes"`.

Esperado:
- **El guard deja pasar el comando.** Git responde con su propio mensaje de que no hay nada en el stage, porque no hubo `git add`, y no crea ningún commit.
- **Al cerrar el turno, el Stop no bloquea:** hay bandera vigente para la misma lista de tocados.

## 6. Opcional: el guard sin manifiesto

En una sesión abierta en un repo sin `.claude/harness.json`, `git reset --hard` se deniega igual, y `git commit` no se juzga. No lo pruebes en un repo con trabajo sin commitear.

## 7. Limpieza

Prompt, o a mano:

> Borra `src/prueba-arnes.ts`.

Después, en PowerShell:

```powershell
cd C:\Users\MauricioTriana\Desktop\PDV\academico\api-academico
git status --short          # otra vez solo: ?? .claude/harness.json
Remove-Item ..\.tmp\harness\gate\api-academico.json -ErrorAction SilentlyContinue
```

`.tmp/` está en el `.gitignore` del repo del arnés, así que la bandera, la marca de after-edit y la timeline no ensucian ningún repo.

## Qué reportar

Por cada paso: si salió como está escrito, y si no, el texto exacto que viste. Una diferencia en ramas o en conteos de archivos por cambios previos no es un fallo. Sí lo es que falte un bloqueo, que el Stop bloquee dos veces en el mismo turno, o que el commit sin bandera no se deniegue.
