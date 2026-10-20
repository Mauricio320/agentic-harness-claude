# Prueba manual de la fase 3b: plan, build, worktrees, memoria y sync

Las skills solo se prueban de verdad en una sesión interactiva con el plugin cargado. Esta prueba se hace sobre un clon de `api-academico` dentro de `.tmp` del worktree `agentic-harness-3b`, nunca sobre el original. El clon trabaja contra un repo bare, también en `.tmp`, que hace de origin: un push nunca llega al repo real. El paso 10 borra todo.

La fase 3b se cierra cuando los pasos 1 a 9 salen como están escritos y lo confirmas. verify, review y ship son de la fase 3a. Hasta el merge de las dos ramas, donde una skill dice "sigue verify", la verificación se hace a mano con los comandos del paso 5.

## 0. Montar el clon

En PowerShell:

```powershell
$PDV = "C:\Users\<usuario>\Desktop\PDV"     # la carpeta que contiene agentic-harness-3b y academico
$W = "$PDV\agentic-harness-3b"
cd $W
git branch --show-current                     # feature/fase-3b-plan-build
New-Item -ItemType Directory -Force .tmp | Out-Null
git clone --bare --no-hardlinks "$PDV\academico\api-academico" .tmp\origen-api-academico.git
git clone .tmp\origen-api-academico.git .tmp\api-academico
cd .tmp\api-academico
git switch -c feature/crud-talleres origin/feature/colegio-convenio-permissions
```

Adopta el arnés en el clon. El manifiesto es el de api-academico más las `riskPaths` y `memory` que completa la persona al adoptar. Además, se quita el git-guard del arnés anterior (docs/PLAN.md §8):

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
  "memory": { "notes": "docs/decisions", "gotchas": "docs/gotchas.md", "graphify": true }
}
'@ | Set-Content -Encoding utf8 .claude\harness.json
node -e "const f='.claude/settings.json',fs=require('fs'),s=JSON.parse(fs.readFileSync(f,'utf8'));delete s.hooks;fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n')"
git rm -q .claude\hooks\git-guard.js
git add .claude\harness.json .claude\settings.json
git commit -m "chore: adopta el arnés (manifiesto y sin el git-guard anterior)"
node "$W\plugins\arnes\scripts\lib\manifest.js" validate .claude\harness.json    # válido: ... (manifiesto de repo)
npm ci --no-audit --no-fund
npx prisma generate
node "$W\plugins\arnes\scripts\typecheck-baseline.js" capture api-academico HEAD .tmp\harness\tsc-base.json   # foto OK, 0 diagnósticos
Copy-Item -Recurse "$PDV\academico\api-academico\graphify-out" graphify-out
Add-Content .git\info\exclude "graphify-out/"
graphify --help                                   # si no responde: $env:PATH += ";$HOME\.local\bin"
git status --short                                # vacío
```

Las otras terminales de esta prueba necesitan las mismas líneas `$PDV = ...` y `$W = ...` antes de sus comandos.

## 1. SessionStart, el lock de sesión y SessionEnd

```powershell
cd "$W\.tmp\api-academico"
claude --plugin-dir "$W\plugins\arnes" --plugin-dir "$W\plugins\arnes-ui"
```

1. `/hooks` lista `SessionEnd` además de los de la fase 2.
2. En otra terminal:

   ```powershell
   Get-Content "$W\.tmp\api-academico\.tmp\harness\sessions\*.json"
   ```

   Muestra un lock con `pid`, `session`, `cwd` y `at`.
   - Si `pid` es un número, `Get-Process -Id <pid>` tiene que mostrar el proceso de Claude Code. Eso confirma que `CLAUDE_PID` llega a los hooks.
   - Si `pid` es `null`, anótalo. El aviso del paso 2 igual funciona, pero un lock de una sesión que murió sin `SessionEnd` dura 24 h.

## 2. Aviso de sesión concurrente

Con la sesión del paso 1 abierta, en una segunda terminal:

```powershell
cd "$W\.tmp\api-academico\src"
claude --plugin-dir "$W\plugins\arnes"
```

Prompt:

> Sin usar herramientas, copia literal las tres primeras líneas del contexto que te inyectó el arnés.

Esperado:

```
arnes · api-academico · repo · raíz <PDV>\agentic-harness-3b\.tmp\api-academico
Aviso: hay otra sesión de Claude activa(s) en este proyecto. Esta sesión debe trabajar en su propio worktree (/arnes:worktree open <slug>), no en el mismo árbol:
- <PDV>/agentic-harness-3b/.tmp/api-academico desde <fecha hora> (pid <pid de la primera>)
```

Sal de esa segunda sesión con `/exit`. Su lock desaparece de `.tmp\harness\sessions` y el de la primera sigue ahí.

## 3. /arnes:plan

En la sesión del paso 1:

> /arnes:plan CRUD de talleres: listar, crear, editar y eliminar talleres; el modelo Taller ya existe en el esquema de Prisma; solo roles ADMIN y COORDINADOR pueden crear y eliminar; un taller con alumnos inscritos no se elimina, se desactiva

Esperado:
1. Corre `timeline.js start plan` y `manifest.js show`.
2. Lee `CLAUDE.md` y `.claude/rules/academico-architecture.md`, y pregunta a graphify (`graphify query`, `explain`) antes de abrir archivos.
3. Escribe `.tmp\harness\plan.md` con las secciones en este orden:
   - `# Plan: …`
   - `Issue:`
   - `## Criterios de aceptación`, con `[literal]` e `[inferido]`.
   - `## Contrato de API`, con método, ruta, request, response y roles por endpoint.
   - `## Datos`, que dice `sin migración`.
   - `## Workspaces y orden`
   - `## Archivos previstos`
   - `## Zonas de riesgo`
   - `## Preguntas`, cada una con `Recomendación:` y `Alternativa:`.
   - `## Fuera de alcance`
4. Lo que el plan tiene que haber descubierto en el código:
   - La tabla `taller` existe y hoy solo hay un repositorio, sin endpoints.
   - Las inscripciones son `usuario_taller`.
   - El acceso no se da por nombre de rol, sino con permisos `taller.*` que se otorgan en el mantenedor de roles (ADR 0001).
5. Las zonas de riesgo citan `src/common/constants/acl*.ts` (el catálogo de permisos) y dicen `REVISIÓN HUMANA OBLIGATORIA`.
6. Muestra el plan y pide confirmación. No edita código ni lanza agentes.

La redacción cambia de una corrida a otra; lo que se revisa es la estructura y lo descubierto. Como referencia, `plan.md` de la corrida de construcción se pegó en el cierre de la sesión que construyó la fase.

## 4. Aprobar y /arnes:build

Prompt:

> Apruebo el plan con las recomendaciones de todas las preguntas. Construye.

Esperado:
1. `plan.md` pasa a tener `Aprobado: <fecha>` y `## Decisiones`, y la timeline anota `fin ok` de plan.
2. El modelo carga la skill build sin que la invoques. arnes-ui muestra `Construyendo (dev api-academico)`.
3. Se lanza un agente `arnes:dev` en sonnet. Vuelve con seis secciones: `## Contrato resultante`, `## Archivos tocados`, `## Desviaciones del plan`, `## Cobertura de criterios` con `archivo:línea`, `## Riesgo` y `## Pendiente para verify`.
4. Build abre algunas de las líneas citadas.
5. El reporte final termina con `Construido, sin verificar. Sigue verify.` y marca `REVISIÓN HUMANA OBLIGATORIA` por el catálogo de permisos.
6. El dev no escribió ni tocó ningún `*.spec.ts`: `git status --short` no lista specs.
7. El Stop bloquea una vez por código sin bandera, como en la fase 2.

## 5. Verificar y commitear el build, a mano

Hasta el merge con la 3a, verify se hace desde tu terminal. Desde el clon:

```powershell
$S = "$W\plugins\arnes\scripts"
node "$S\typecheck-baseline.js" diff api-academico HEAD .tmp\harness\tsc-base.json       # sin diagnósticos nuevos respecto de la foto del paso 0
node "$S\touched-files.js" --ws api-academico --relative --ext ts                          # lintea esta lista con el lint del manifiesto
node "$S\test-select.js" --ws api-academico                                                # corre esos specs con npx jest --runTestsByPath
npx jest src/common/utils/acl-cobertura.spec.ts src/common/utils/update-sin-activo.spec.ts --runTestsByPath
node "$S\gate-flag.js" write api-academico --result pass                                    # solo si todo lo anterior salió verde
git add -A src
git commit -m "feature(taller): CRUD de talleres con borrado bloqueado si hay inscritos"
```

## 6. Secretos por shell

Prompt:

> Corre exactamente `cat .env | grep DB_` y después `Get-Content -Path .env.local -Raw` en PowerShell.

Esperado: los dos se deniegan.
- El primero, con `arnes guard: cat .env: es un archivo .env. Los secretos no entran al transcript; …`.
- El segundo, con el mismo motivo para `Get-Content .env.local`.

`cat .env.example` pasa.

## 7. /arnes:worktree

1. `/arnes:worktree open taller-select-activos --issue "CRUD de talleres"`. Esperado:
   - `abierto api-academico: <ruta>/.tmp/harness/worktrees/api-academico/taller-select-activos en wt/feature/crud-talleres/taller-select-activos (desde feature/crud-talleres)`.
   - Después, la salida de `list`.
   - `.tmp\harness\worktrees.json` tiene el registro con `status: "abierto"`.
2. En tu terminal, haz un commit dentro del worktree, como si fuera el agente:

   ```powershell
   $WT = "$W\.tmp\api-academico\.tmp\harness\worktrees\api-academico\taller-select-activos"
   (Get-Content "$WT\src\modules\taller\taller.controller.ts") -replace "Listar talleres para selector","Listar talleres activos para selector" | Set-Content "$WT\src\modules\taller\taller.controller.ts"
   git -C $WT commit -am "feature(taller): el resumen del selector dice que lista solo activos"
   ```

   Si el resumen del selector quedó con otro texto en tu build, cambia otra línea cualquiera.
3. Prompt: `¿Qué worktrees quedan sin integrar?`. Al cerrar el turno, el Stop no bloquea, porque el commit es de antes del prompt. Avisa: `arnes: siguen commits sin integrar en api-academico wt/feature/crud-talleres/taller-select-activos (1 commit(s) fuera de feature/crud-talleres); este turno no los tocó.`
4. Prompt: `Corre exactamente git worktree remove --force .tmp/harness/worktrees/api-academico/taller-select-activos`. El guard lo deniega con `su rama wt/feature/crud-talleres/taller-select-activos tiene 1 commit(s) que no están en feature/crud-talleres`.
5. `/clear` y prompt: `Copia literal las líneas de worktrees del contexto del arnés`. Esperado:
   - `Worktrees sin integrar (1): …`
   - `- api-academico wt/feature/crud-talleres/taller-select-activos → feature/crud-talleres · 1 commit(s) sin integrar · abierto el <fecha>`
6. `/arnes:worktree integrate taller-select-activos`. Esperado:
   - `integrado api-academico: … con el merge <hash> (1 commit(s)); worktree y rama borrados`.
   - `list --all` muestra el registro como `integrado`, con su merge.
   - `git log --graph --oneline -3` muestra un commit de merge con dos padres, no un squash.
   - El modelo propone verify sobre la rama del issue.
7. `/arnes:worktree open taller-descartado` y después `/arnes:worktree close taller-descartado`. Esperado: `cerrado api-academico: wt/feature/crud-talleres/taller-descartado, sin commits propios; worktree y rama borrados`. `list --all` lo muestra como `cerrado`.

## 8. /arnes:memory

1. `/arnes:memory decision Un taller con alumnos inscritos no se borra: el borrado responde 400`.
   - Si la conversación no tiene el porqué y la alternativa, los pregunta en un solo mensaje.
   - Escribe `docs\decisions\<fecha>-<slug>.md` con `# título`, `## Qué`, `## Por qué` y `## Alternativa descartada`.
   - Avisa que `docs/` está ignorado por git en esta rama de api-academico, así que el archivo no se versiona sin `git add -f`.
2. `/arnes:memory gotcha npx prisma migrate falla sin connection string porque DATABASE_URL la arma scripts/set-database-url.js`. Crea `docs\gotchas.md` con `# Gotchas` y una línea `- <fecha> · api-academico · síntoma → causa → qué hacer`.
3. `/arnes:memory recall taller`. Cita el archivo de la decisión con su fecha, consulta graphify, y no escribe nada.
4. `/clear`. El contexto del arnés muestra la decisión bajo `Decisiones recientes:`.

## 9. /arnes:sync

En otra terminal, un compañero mergea a `main` del origin de prueba:

```powershell
cd "$W\.tmp"
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
1. Precondiciones: el árbol está limpio (el build quedó commiteado en el paso 5), no hay merge a medias, y la rama es `feature/crud-talleres`.
2. Crea `respaldo/feature/crud-talleres-<AAAAMMDD-HHMM>`.
3. Corre `git fetch origin main` y `git merge origin/main`, que sale sin conflictos.
4. `merged-files.js --ws api-academico` dice `1 de ambos lados · 2 entraron`, con `ambos package.json`, `entró package.json` y `entró scripts/check-env.js`.
5. Verifica:
   - Typecheck sin diagnósticos nuevos.
   - El lint de `scripts/check-env.js` falla con `was not found by the project service`. Es previo y es del repo: su eslint no cubre `scripts/`, y lo mismo le pasa a `scripts/set-database-url.js`.
   - test-select no elige ningún spec.
6. El reporte incluye el respaldo, el commit que entró (`git log --oneline <respaldo>..HEAD --no-merges`) y cómo volver atrás desde tu terminal. No hay push.

Al final, `/arnes:timeline` muestra plan, build (por workspace), worktree, memory y sync con sus duraciones, y las notas del Stop.

## 10. Limpieza

Cierra las sesiones con `/exit`: sus locks desaparecen. Después:

```powershell
cd $W
Remove-Item -Recurse -Force .tmp\api-academico, .tmp\origen-api-academico.git, .tmp\companero
```

## Comprobación sin sesión

Los hooks también se prueban sin sesión, con el JSON del evento por stdin. Esto se hizo en la sesión que construyó la fase, porque una sesión no puede lanzar otra (`docs/NOTAS-FASE-3B.md`). Por ejemplo, el Stop de la condición (b), con un worktree con commits hechos después del prompt:

```powershell
$C = "$W\.tmp\api-academico" -replace '\\','/'
"{""hook_event_name"":""UserPromptSubmit"",""prompt"":""x"",""cwd"":""$C""}" | node "$S\hooks\prompt-context.js"
# … commit en el worktree …
"{""hook_event_name"":""Stop"",""stop_hook_active"":false,""cwd"":""$C""}" | node "$S\hooks\stop-gate.js"
```

Esperado: `{"decision":"block","reason":"arnes: hay worktrees del issue con commits sin integrar: …"}`.
