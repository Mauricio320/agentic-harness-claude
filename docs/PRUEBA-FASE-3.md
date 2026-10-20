# Prueba manual de la fase 3: el flujo completo sin invocar comandos

Esta guía reemplaza a las de las dos mitades (3a y 3b). La prueba se hace en una sesión real con los dos plugins cargados, `arnes` y `arnes-ui`, sobre un clon de `api-academico` dentro del `.tmp` del repo del arnés, nunca sobre el original. El clon trabaja contra un repo bare, también en `.tmp`, que hace de origin: un push nunca llega al repo real. El paso 11 borra todo.

La fase 3 se cierra cuando los pasos 1 a 10 salen como están escritos y lo confirmas. El criterio de salida (§10) es que un issue real de api-academico va de punta a punta sin invocar comandos. La persona escribe el pedido y aprueba el plan. Las únicas skills que invoca a mano son las que §4 reserva a la persona: ship, worktree y sync.

## 0. Montar el clon

En PowerShell:

```powershell
$PDV = "C:\Users\<usuario>\Desktop\PDV"     # la carpeta que contiene agentic-harness y academico
$H = "$PDV\agentic-harness"
cd $H
git branch --show-current                     # feature/fase-3
# si quedó el clon de otra corrida en .tmp, bórralo primero con los comandos del paso 11
New-Item -ItemType Directory -Force .tmp | Out-Null
git clone --bare --no-hardlinks "$PDV\academico\api-academico" .tmp\origen-api-academico.git
git clone .tmp\origen-api-academico.git .tmp\api-academico
cd .tmp\api-academico
git switch -c feature/crud-talleres origin/feature/colegio-convenio-permissions
```

En los textos esperados, `<PDV>` es la misma ruta que `$PDV`. Las otras terminales de esta prueba necesitan las mismas líneas `$PDV = ...` y `$H = ...` antes de sus comandos.

Adopta el arnés en el clon. El manifiesto es el de api-academico más lo que completa la persona al adoptar: las `riskPaths`, `memory` y el prefijo de rama. Además se quita el git-guard del arnés anterior (docs/PLAN.md §8):

```powershell
@'
{
  "version": 1,
  "name": "api-academico",
  "workspaces": [
    {
      "name": "api-academico", "path": ".", "git": ".",
      "remote": "gitlab.com/preupdv/apps/api-academico", "defaultBranch": "main", "stack": "nestjs-prisma",
      "commands": {
        "typecheck": ["npx tsc --noEmit"],
        "lint": "npx eslint {files} --max-warnings=0 --no-warn-ignored",
        "test": "npx jest {specs} --runTestsByPath --verbose",
        "testAll": "npx jest",
        "build": "npm run build"
      },
      "specPattern": "{dir}/{name}.spec.ts",
      "riskPaths": ["prisma/migrations/**", "prisma/schema.prisma", "src/modules/auth/**", "src/modules/acl/**",
                    "src/modules/acl-*/**", "src/common/guards/**", "src/common/constants/acl*.ts"],
      "forbidden": ["npm run format", "npm run lint", "prisma migrate reset"]
    }
  ],
  "integration": { "branchPrefix": "feature/" },
  "memory": { "notes": "docs/decisions", "gotchas": "docs/gotchas.md", "graphify": true }
}
'@ | Set-Content -Encoding utf8 .claude\harness.json
node -e "const f='.claude/settings.json',fs=require('fs'),s=JSON.parse(fs.readFileSync(f,'utf8'));delete s.hooks;fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n')"
git rm -q .claude\hooks\git-guard.js
git add .claude\harness.json .claude\settings.json
git commit -m "chore: adopta el arnés (manifiesto y sin el git-guard anterior)"
node "$H\plugins\arnes\scripts\lib\manifest.js" validate .claude\harness.json    # válido: ... (manifiesto de repo)
$env:PUPPETEER_SKIP_DOWNLOAD = "1"; npm ci --no-audit --no-fund
npx prisma generate
Copy-Item -Recurse "$PDV\academico\api-academico\graphify-out" graphify-out
Add-Content .git\info\exclude "graphify-out/"
graphify --help                                   # si no responde: $env:PATH += ";$HOME\.local\bin"
```

`npx prisma generate` hace falta porque sin el cliente generado, `Prisma.dmmf` queda vacío y una suite no llega a correr. Es un problema del clon, no del repo.

### La línea base de tests y los rojos conocidos

```powershell
node "$H\plugins\arnes\scripts\test-baseline.js" capture api-academico
```

Esperado, en menos de un minuto: `314 spec(s), 5279 pasan, 18 fallan, 0 saltados`, y la lista de las 18 fallas. Son las mismas de la lista vieja del repo, `.claude\shared\jest-rojos-conocidos.txt`, del 2026-08-27. Pásalas al formato del arnés, con esa fecha:

```powershell
$S = "$H\plugins\arnes\scripts"
node "$S\test-baseline.js" check api-academico src/modules/conceptos-item/conceptos-item.repository.spec.ts src/modules/conceptos-tipo/conceptos-tipo.repository.spec.ts src/modules/horario-sede/horario-sede.service.spec.ts src/modules/ficha-matricula/ficha-matricula.service.spec.ts | Select-String "falla nueva: " | ForEach-Object {
  $l = ($_.Line -split 'falla nueva: ')[1]; $i = $l.IndexOf(' › ')
  "2026-08-27 | $($l.Substring(0, $i)) | $($l.Substring($i + 3))"
} | Set-Content -Encoding utf8 tests\known-failures.txt
(Get-Content tests\known-failures.txt).Count      # 18
node "$S\test-baseline.js" check api-academico src/modules/horario-sede/horario-sede.service.spec.ts
git add tests\baseline.json tests\known-failures.txt
git commit -m "gates: línea base de tests y rojos conocidos con fecha"
git status --short                                # vacío
```

El `check` del spec de horario-sede tiene que decir `ok · 1 spec(s) pedidos · 129 pasan, 7 fallan, 0 saltados · base 129 pasan, 7 fallan, 0 saltados`, con siete líneas `preexistente (2026-08-27): …`. Las preexistentes no ponen rojo, y una falla que no coincida exacto sí.

## 1. La sesión, el lock y CLAUDE_PID

```powershell
cd "$H\.tmp\api-academico"
claude --plugin-dir "$H\plugins\arnes" --plugin-dir "$H\plugins\arnes-ui"
```

Acepta el diálogo de confianza de la carpeta. Esta es la sesión de toda la prueba.

1. `/hooks` lista `SessionEnd` además de los de la fase 2.
2. Este paso comprueba si `CLAUDE_PID` llega a los hooks. En otra terminal:

   ```powershell
   Get-Content "$H\.tmp\api-academico\.tmp\harness\sessions\*.json"
   ```

   Muestra un lock con `pid`, `session`, `cwd` y `at`.
   - Si `pid` es un número, `Get-Process -Id <pid>` tiene que mostrar `claude`, el proceso de esta sesión. `CLAUDE_PID` llega.
   - Si `pid` es `null`, anótalo: no llega. El aviso del paso 2 igual funciona, pero el lock de una sesión que murió sin `SessionEnd` dura 24 h.

   En `claude -p` llega: en la corrida automática del 2026-10-20, el lock traía el pid del `claude.exe` de esa corrida. Falta verlo en una sesión interactiva.

## 2. Aviso de sesión concurrente

Con la sesión del paso 1 abierta, en una segunda terminal:

```powershell
cd "$H\.tmp\api-academico\src"
claude --plugin-dir "$H\plugins\arnes"
```

Prompt:

> Sin usar herramientas, copia literal las tres primeras líneas del contexto que te inyectó el arnés.

Esperado:

```
arnes · api-academico · repo · raíz <PDV>\agentic-harness\.tmp\api-academico
Aviso: hay otra sesión de Claude activa(s) en este proyecto. Esta sesión debe trabajar en su propio worktree (/arnes:worktree open <slug>), no en el mismo árbol:
- <PDV>/agentic-harness/.tmp/api-academico desde <fecha hora> (pid <pid de la primera>)
```

Sal de esa segunda sesión con `/exit`. Su lock desaparece de `.tmp\harness\sessions` y el de la primera sigue ahí.

## 3. El plan, sin invocarlo

En la sesión del paso 1, el pedido tal como lo escribiría la persona, sin comando:

> Implementa este issue: CRUD de talleres: listar, crear, editar y eliminar talleres; el modelo Taller ya existe en el esquema de Prisma; solo roles ADMIN y COORDINADOR pueden crear y eliminar; un taller con alumnos inscritos no se elimina, se desactiva.

Esperado:
1. El modelo carga `arnes:plan` por su cuenta. La banda de arnes-ui debería pasar a `Planeando`. En la corrida automática no pasó: el transcript dijo `arnes-ui: its skill.prompt hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it.` Anota si en tu sesión sale lo mismo.
2. Corre `timeline.js start plan` y `manifest.js show`. Lee `CLAUDE.md` y las rules, y consulta graphify (`graphify query`).
3. Escribe `.tmp\harness\plan.md` con las secciones en este orden:
   - `# Plan: …` e `Issue:`;
   - `## Criterios de aceptación`, con `[literal]` e `[inferido]`;
   - `## Contrato de API`, con método, ruta, request, response y permiso por endpoint;
   - `## Datos`, que termina en `Sin migración.`;
   - `## Workspaces y orden` y `## Archivos previstos`;
   - `## Zonas de riesgo`, con `REVISIÓN HUMANA OBLIGATORIA` por `src/common/constants/acl*.ts`;
   - `## Preguntas`, cada una con `Recomendación:` y `Alternativa:`;
   - `## Fuera de alcance`.
4. Lo que el plan tiene que haber descubierto en el código:
   - El modelo es `taller`, en minúsculas, y hoy solo tiene un repositorio con `findById`, sin endpoints.
   - Las inscripciones son `usuario_taller`.
   - El acceso no va por nombre de rol, sino con permisos `taller.*` que se otorgan en el mantenedor de roles (ADR 0001), y el catálogo de permisos no tiene el ítem `taller`.
5. Muestra el plan y pide confirmación. No edita código ni lanza agentes.

La redacción cambia de una corrida a otra; lo que se revisa es la estructura y lo descubierto.

## 4. Build, verify y review, sin invocarlos

Prompt:

> Apruebo el plan con las recomendaciones de todas las preguntas. Constrúyelo y déjalo listo para entregar.

Esperado, en este orden y sin que invoques nada:
1. **Plan:** `plan.md` pasa a tener `Aprobado: <fecha>` y `## Decisiones` en lugar de `## Preguntas`. La timeline anota `fin ok` de plan.
2. **Build:** el modelo carga `arnes:build` y lanza un `arnes:dev` en sonnet. La banda muestra `Construyendo (dev api-academico)`.
   - El dev vuelve con `## Contrato resultante`, `## Archivos tocados`, `## Desviaciones del plan`, `## Cobertura de criterios` con `archivo:línea`, `## Riesgo` y `## Pendiente para verify`.
   - Build abre algunas de las líneas citadas. El dev no escribe specs.
   - Cuando pida `npm run acl:generar` y `npm run acl:check`, apruébalos en el diálogo de permisos. Regeneran el catálogo de permisos, y sin él falla `acl-cobertura.spec.ts`.
   - Si pide `npm run start` para comprobar el arranque, recházalo: el clon no tiene base de datos. Es la decisión abierta 9 de §12.
   - Si un turno cierra con código sin bandera, el Stop lo bloquea una vez con `turno bloqueado sin verificar: api-academico (… archivo(s) de código: …)`.
3. **Verify:** el modelo carga `arnes:verify` por su cuenta.
   - `test-select --missing` lista los archivos nuevos sin spec, y se lanza `arnes:test-writer` para los servicios y el controlador. DTOs, constantes, interfaz, módulo y mocks quedan sin spec por el estándar del repo.
   - `ci-gate.js --ws api-academico --base HEAD` sale verde. La primera vez dice `foto del base capturada`, y las siguientes, mientras el HEAD no cambie, `foto del base reutilizada`. En la corrida automática, el último gate fue:

     ```
       base       ff7377f753 (--base HEAD) · 25 tocado(s), 25 de código
       typecheck  ok · sin diagnósticos nuevos (base 0, ahora 0) · foto del base reutilizada
       lint       ok · 25 archivo(s)
       tests      ok · 5 spec(s) · 61 pasan, 0 fallan, 0 saltados · base 23 pasan, 0 fallan, 0 saltados
                  línea base: hay 38 test(s) más que en la base; quedan protegidos al recapturarla (test-baseline.js capture, commit con gates:)

     resultado: VERDE. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.
     ```

   - Escribe la bandera solo con el gate en verde.
   - Si el modelo corre además la suite completa (`npx jest`), arnes-ui avisa `gate en rojo: ✗ jest api-academico` por los 18 rojos conocidos. El mod no lee `tests/known-failures.txt`; el gate sí, y es el que manda.
4. **Review:** el modelo carga `arnes:review` por su cuenta.
   - `review.js input` imprime `api-academico: 25 tocado(s) · REVISIÓN HUMANA OBLIGATORIA: src/common/constants/acl-catalogo.generated.ts, src/common/constants/acl-overrides.ts`, la ruta del plan y la de `input.md`.
   - Se lanza `arnes:reviewer` una vez por ronda, con Read, Grep y Glob, sin Bash. Su reporte empieza con `REVISIÓN HUMANA OBLIGATORIA: …`, trae `### Cumplimiento de criterios` con los criterios del plan y termina con `BLOQUEANTES: <n>`.
   - Corre `review.js mark --blockers <n>`, y la timeline anota `review fin fail` o `fin ok`.
5. **Con bloqueantes,** el modelo los corrige, los de specs con el test-writer y los de código con el dev. Después vuelve a verify y a review sin que se lo pidas, hasta `BLOQUEANTES: 0`. En la corrida automática fueron tres rondas: 3 bloqueantes (el catálogo sin regenerar y dos datos escritos a mano en specs), después 1 (otro dato a mano) y al final 0.
6. **El reporte final:**
   - empieza con `REVISIÓN HUMANA OBLIGATORIA` por el catálogo de permisos;
   - dice que no hizo commit;
   - lista lo que queda fuera del código: otorgar los permisos `taller.*` en el mantenedor de roles y confirmar que el rol COORDINADOR existe;
   - cierra con la frase de que verde significa que cumple convenciones y compila/testea, nunca que sea correcto en el negocio.

Si el turno se corta, por ejemplo esperando una aprobación, sigue con `Sigue donde quedaste y déjalo listo para entregar`, sin comandos.

## 5. /arnes:ship --solo-commit

Ship lo invoca la persona (`disable-model-invocation`). Dentro de los 30 minutos de la bandera:

> /arnes:ship --solo-commit

Esperado:
1. `ship.js check`:

   ```
   - api-academico (<ruta del clon>) · rama feature/crud-talleres · 25 tocado(s), 0 borrado(s)
       bandera: vigente
       revisión: revisión hecha, sin bloqueantes
       riskPaths tocadas: src/common/constants/acl-catalogo.generated.ts, src/common/constants/acl-overrides.ts → REVISIÓN HUMANA OBLIGATORIA en el MR
       línea base de tests: no cambia
       convención: sin commitlint · CLAUDE.md <ruta del clon>\CLAUDE.md
       últimos asuntos de origin/main:
         …
   worktrees abiertos del issue: ninguno
   orden de commit: api-academico
   prefijo de rama: feature/ (integration.branchPrefix)
   rama propuesta: feature/crud-talleres (la actual)
   resultado: LISTO
   ```

   Si pasaron más de 30 minutos, dice `NO LISTO` por la bandera y la skill pide `/arnes:verify`. También es lo esperado.
2. `worktree-ledger.js pending --target feature/crud-talleres` → `nada sin integrar en feature/crud-talleres`.
3. `ship.js branch feature/crud-talleres` → `api-academico: reutiliza feature/crud-talleres (ya es la actual)`.
4. `ship.js stage api-academico` → `api-academico: 25 archivo(s) en el stage`, con la lista.
5. Un solo commit con la forma de los asuntos del repo (`feature(taller): …`), que el guard deja pasar porque la bandera está vigente. Después, `git log -1 --stat`.
6. La timeline anota `ship fin ok · solo commit`. No hay push ni MR. El reporte dice que se hacen con `/arnes:ship` sin `--solo-commit`, que pide confirmación antes de publicar.

Comprueba en tu terminal:

```powershell
git log --oneline -3           # el commit de ship, el gates: y el de adopción
git status --short             # vacío
```

## 6. Worktrees: los cercos y ship ante el registro

1. `/arnes:worktree open taller-select-activos --issue "CRUD de talleres"`. Esperado:
   - `abierto api-academico: <ruta>/.tmp/harness/worktrees/api-academico/taller-select-activos en wt/feature/crud-talleres/taller-select-activos (desde feature/crud-talleres)`, y después la salida de `list`.
   - `.tmp\harness\worktrees.json` tiene el registro con `status: "abierto"`.
   - En unos segundos, la banda de arnes-ui termina en `· 1 wt sin integrar`.
   - En el panel (`/arnes-panel`), la sección `Worktrees sin integrar` lista `api-academico · wt/feature/crud-talleres/taller-select-activos → feature/crud-talleres`. `Lo que sigue` dice `falta integrar wt/feature/crud-talleres/taller-select-activos (/arnes:worktree integrate)`.
2. En tu terminal, haz un commit dentro del worktree, como si fuera el agente. Basta una línea en blanco al final de un archivo del taller:

   ```powershell
   $WT = "$H\.tmp\api-academico\.tmp\harness\worktrees\api-academico\taller-select-activos"
   Add-Content "$WT\src\modules\taller\taller.controller.ts" ""
   git -C $WT commit -am "feature(taller): ajuste de prueba en el worktree"
   ```

3. Prompt: `¿Qué worktrees quedan sin integrar?`. Al cerrar el turno, el Stop no bloquea, porque el commit es de antes del prompt. Avisa: `arnes: siguen commits sin integrar en api-academico wt/feature/crud-talleres/taller-select-activos (1 commit(s) fuera de feature/crud-talleres); este turno no los tocó.`
4. Prompt: `Corre exactamente git worktree remove --force .tmp/harness/worktrees/api-academico/taller-select-activos`. El guard lo deniega con `su rama wt/feature/crud-talleres/taller-select-activos tiene 1 commit(s) que no están en feature/crud-talleres`.
5. Ship ante el registro, desde tu terminal:

   ```powershell
   node "$S\worktree-ledger.js" pending --target feature/crud-talleres     # exit 1, una línea por worktree abierto
   ```

   Esperado: `api-academico wt/feature/crud-talleres/taller-select-activos → feature/crud-talleres · 1 commit(s) sin integrar · abierto el <fecha>`. Es la consulta que corre `/arnes:ship` con la rama del issue. Con algo tocado en el árbol, `ship.js check` dice `NO LISTO` con `hay 1 worktree(s) del issue sin integrar en feature/crud-talleres`, y la skill termina pidiendo `/arnes:worktree integrate <slug>`.
6. `/clear` y prompt: `Copia literal las líneas de worktrees del contexto del arnés`. Esperado:
   - `Worktrees sin integrar (1): /arnes:worktree integrate <slug>, o close si no tienen commits propios.`
   - `- api-academico wt/feature/crud-talleres/taller-select-activos → feature/crud-talleres · 1 commit(s) sin integrar · abierto el <fecha>`
7. `/arnes:worktree integrate taller-select-activos`. Esperado:
   - `integrado api-academico: … con el merge <hash> (1 commit(s)); worktree y rama borrados`.
   - `list --all` muestra el registro como `integrado`, con su merge.
   - `git log --graph --oneline -3` muestra un commit de merge con dos padres, no un squash.
   - El modelo propone verificar sobre la rama del issue con `/arnes:verify`.
   - La banda deja de mostrar `wt sin integrar`.
8. `/arnes:worktree open taller-descartado` y después `/arnes:worktree close taller-descartado`. Esperado: `cerrado api-academico: wt/feature/crud-talleres/taller-descartado, sin commits propios; worktree y rama borrados`. `list --all` lo muestra como `cerrado`.

## 7. Secretos por shell

Prompt:

> Corre exactamente `cat .env | grep DB_` y después `Get-Content -Path .env.local -Raw` en PowerShell.

Esperado: los dos se deniegan.
- El primero, con `arnes guard: cat .env: es un archivo .env. Los secretos no entran al transcript; …`.
- El segundo, con el mismo motivo para `Get-Content .env.local`.

`cat .env.example` pasa.

## 8. Memoria

1. Prompt, sin comando: `Deja registrada la decisión: un taller con alumnos inscritos no se borra, se desactiva`. El modelo carga memory por su cuenta.
   - Si la conversación no tiene el porqué y la alternativa, los pregunta en un solo mensaje.
   - Escribe `docs\decisions\<fecha>-<slug>.md` con `# título`, `## Qué`, `## Por qué` y `## Alternativa descartada`.
   - Avisa que `docs/` está ignorado por git en esta rama de api-academico, así que el archivo no se versiona sin `git add -f`.
2. Prompt: `Anota como gotcha que npx prisma migrate falla sin connection string porque DATABASE_URL la arma scripts/set-database-url.js`. Crea `docs\gotchas.md` con `# Gotchas` y una línea `- <fecha> · api-academico · síntoma → causa → qué hacer`.
3. Prompt: `¿Qué decidimos sobre los talleres?`. Recall cita el archivo de la decisión con su fecha, consulta graphify, y no escribe nada.
4. `/clear`. El contexto del arnés muestra la decisión bajo `Decisiones recientes:`.

## 9. /arnes:sync

En otra terminal, un compañero mergea a `main` del origin de prueba. El push va al origin bare de `.tmp`, no a GitLab:

```powershell
cd "$H\.tmp"
git clone origen-api-academico.git companero
cd companero
git switch main
(Get-Content package.json) -replace '"version": "1.12.0"','"version": "1.12.0-hotfix.1"' | Set-Content package.json
Set-Content scripts\check-env.js "'use strict';`nif (!process.env.DB_HOST) process.exit(1);"
git add package.json scripts\check-env.js
git commit -m "fix: version de hotfix y chequeo de variables de entorno"
git push origin main
```

En la sesión: `/arnes:sync`. Esperado:
1. Precondiciones: el árbol está limpio, no hay merge a medias, y la rama es `feature/crud-talleres`.
2. Crea `respaldo/feature/crud-talleres-<AAAAMMDD-HHMM>`.
3. Corre `git fetch origin main` y `git merge origin/main`, que sale sin conflictos.
4. `merged-files.js --ws api-academico` dice `1 de ambos lados · 2 entraron`, con `ambos package.json`, `entró package.json` y `entró scripts/check-env.js`.
5. Verifica con `/arnes:verify`:
   - Typecheck sin diagnósticos nuevos, con `foto del base capturada`, porque el merge cambió el HEAD.
   - El lint de `scripts/check-env.js` falla con `was not found by the project service`. Es previo y es del repo: su eslint no cubre `scripts/`.
   - test-select no elige ningún spec.
6. El reporte incluye el respaldo, el commit que entró (`git log --oneline <respaldo>..HEAD --no-merges`) y cómo volver atrás desde tu terminal. No hay push.

## 10. La timeline, con tiempo y costo por etapa

1. `/arnes:timeline` muestra las etapas con sus duraciones y las notas del Stop:
   - plan;
   - build, por workspace;
   - verify, review y ship;
   - worktree, memory y sync.
   Al final va la línea `por etapa: …`.
2. El panel de arnes-ui (`/arnes-panel`) muestra la cronología de la corrida con la duración y el costo de cada etapa, y el promedio de las corridas guardadas. Al cerrar cada turno, el transcript trae el resumen `arnes · corrida: … · más lenta: … · más cara: … ($…)`.

## 11. Limpieza

Cierra las sesiones con `/exit`: sus locks desaparecen de `.tmp\harness\sessions`. Después:

```powershell
cd $H
Remove-Item -Recurse -Force .tmp\api-academico, .tmp\origen-api-academico.git, .tmp\companero
git status --short             # nada: .tmp/ está en el .gitignore del arnés
```

El `node_modules` del clon salió de `npm ci`: es una carpeta propia, no un enlace al original.

## Qué reportar

Por cada paso, di si salió como está escrito, y si no, el texto exacto que viste. No son fallos:
- conteos o fechas distintos porque las ramas avanzaron;
- que el plan, el dev o el reviewer redacten distinto o den otros hallazgos.

Sí son fallos:
- que tengas que invocar plan, build, verify, review o memory para que corran;
- una bandera escrita con un paso en rojo;
- un reviewer con Bash, o que edite archivos;
- ship que commitee sin bandera vigente, con bloqueantes o con worktrees del issue sin integrar;
- un push fuera del origin de `.tmp`.

## Resultado de la corrida automática

2026-10-20, con Claude Code 2.1.304, sobre el clon de los pasos 0 a 5, sin la segunda sesión del paso 2. La sesión de desarrollo lanzó `claude -p` en el clon con los dos plugins por `--plugin-dir`, y retomó la misma sesión con `--resume` en cada turno. `git push` estaba denegado. Los prompts fueron los de la persona, sin comandos salvo ship:
1. El pedido del paso 3: el modelo cargó plan solo y escribió el plan con 12 criterios, 8 preguntas y la zona de riesgo del catálogo.
2. La aprobación del paso 4: build, verify con test-writer, y review con 3 bloqueantes. El Stop bloqueó una vez durante build. `npm run acl:generar` quedó esperando una aprobación que `-p` no puede dar en el chat.
3. `Te apruebo npm run acl:generar …`: el modelo no lo corrió, porque una aprobación en el chat no cambia los permisos de la herramienta, y no buscó otra vía.
4. Con el permiso agregado, y con la base de QA levantada por la persona: el catálogo, una comprobación de arranque contra esa base que se cerró sola, y después verify, la suite completa con sus 18 rojos conocidos y review, con 1 bloqueante. La corrida se cortó aquí por el límite semanal de la cuenta, y se retomó 24 minutos después.
5. `Sigue donde quedaste…`: marcó la revisión, corrigió el bloqueante con el test-writer, verificó y revisó con 0 bloqueantes.
6. `/arnes:ship --solo-commit`: `190a80e feature(taller): agrega CRUD de talleres con permisos y desactivación si hay inscritos`, 25 archivos.

La timeline del clon cerró con `por etapa: plan 6m06s · build 9m19s · verify 8m41s · review 32m47s · ship 26s`. Review incluye los 24 minutos del corte; sin ellos son 8m41s en tres rondas.

El costo real de los seis turnos fue de $13.36. En una sesión retomada, el `result` de `claude -p` trae el costo acumulado, así que el de cada turno es la diferencia con el anterior. Por etapa, repartiendo el costo de cada turno entre sus mensajes según los tokens y la hora de cada uno: plan $1.43, build $1.44, verify $1.95, review $3.93 y ship $0.36. Fuera de toda etapa quedaron $4.26: la aprobación del plan, el catálogo y el arranque del turno 4, las correcciones del test-writer entre review y verify, y los reportes finales.

El lock del paso 1 traía el pid del `claude.exe` de la corrida: en `-p`, `CLAUDE_PID` llega a los hooks.

Hallazgos, sin corregir:
- **`skill.prompt` de arnes-ui no corre.** `cc-plugin-sec-default` lo salta, como al `classic.Stop` en la fase 2b. La banda no muestra las etapas que solo se ven al cargar una skill: Planeando, Entregando, Guardando memoria y Sincronizando. Construyendo, Verificando y Revisando sí salen, por los agentes y las herramientas.
- **arnes-ui avisa `gate en rojo: ✗ jest`** cuando el modelo corre la suite completa con rojos conocidos, porque no lee `tests/known-failures.txt`.
- **plan y build encadenan comandos.** Las dos skills no traen la línea de verify, review y ship que pide correr cada comando solo, y el plan corrió `cd … && node … ; echo "---"; node …`. En una sesión interactiva eso pide permisos aparte.

## Resultado de la prueba manual

2026-10-20, con Claude Code 2.1.304, en una sesión interactiva con `arnes` y `arnes-ui` por `--plugin-dir` sobre el clon. La persona hizo los pasos 1, 3, 4, 5 y 10, y salieron como están escritos:
- **Paso 1:** `CLAUDE_PID` llega a los hooks también en una sesión interactiva. El lock traía un `pid` numérico.
- **Paso 3:** el pedido en lenguaje natural cargó `arnes:plan` por su cuenta. El plan consultó graphify y salió con los criterios, el contrato, los datos sin migración, la zona de riesgo en `acl*.ts` y cinco preguntas, cada una con recomendación y alternativa. Pidió aprobación sin tocar código.
- **Paso 4:** con la aprobación corrieron solos build con el dev, verify con tres specs del test-writer y el gate en verde, y review con cero bloqueantes y cinco sugerencias. El reporte empezó con `REVISIÓN HUMANA OBLIGATORIA` y no hizo commit.
- **Paso 5:** `/arnes:ship --solo-commit` dio `LISTO` y creó el commit `8127c99` con 22 archivos, sin push.
- **Paso 10:** la timeline cerró con `plan 16m01s · build 8m13s · verify 4m21s · review 2m05s · ship 19s`.

Los pasos 2 y 6 a 9 no se repitieron en esta pasada.

Hallazgos, para la ronda de correcciones antes del piloto:
- **La línea `Plan:` del panel mostró texto corrupto:** `Plnd CRUD dw talleres`.
- **Los 16m01s de plan incluyen la espera de la aprobación.** La etapa cierra cuando la persona aprueba, así que la medición le carga al plan el tiempo del humano.

La fase 3 queda cerrada con la versión 0.5.0 (tag `v0.5.0`).
