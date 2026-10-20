# Prueba manual de la fase 3a: verify, review y ship

Esta prueba corre las tres skills nuevas en una sesión real sobre un clon local de `api-academico`, dentro del `.tmp/` del repo del arnés. El original sigue siendo de solo lectura: el clon tiene su propio `node_modules`, su URL de push anulada y se borra al final. Nada se pushea.

La fase 3a se cierra cuando los pasos 3 a 5 salen como están escritos y lo confirmas.

## 0. El clon

En PowerShell:

```powershell
$PDV = "C:\Users\<usuario>\Desktop\PDV"     # la carpeta que contiene agentic-harness y academico
cd $PDV\agentic-harness
git branch --show-current                        # feature/fase-3a-verify-review-ship
$CLON = "$PDV\agentic-harness\.tmp\api-academico"
git clone --no-hardlinks "$PDV\academico\api-academico" $CLON
cd $CLON
git remote set-url --push origin "no-push: clon de prueba del arnés"
git remote -v                                    # la línea (push) dice no-push
git switch main
git switch -c feature/prueba-arnes-3a
$env:PUPPETEER_SKIP_DOWNLOAD = "1"; npm ci --no-audit --no-fund
npx prisma generate
```

En los textos esperados, `<PDV>` es la misma ruta que `$PDV`.

- **`--no-hardlinks`:** el clon no comparte archivos de objetos con el original.
- **La URL de push anulada:** un `git push` desde el clon falla en vez de llegar al original.
- **`npx prisma generate`:** sin el cliente generado, `Prisma.dmmf` queda vacío y la suite de `boolean-field.interceptor.spec.ts` no llega a correr. Es un artefacto del clon, no del repo.

## 1. Adopción en el clon

El manifiesto de `api-academico` no está commiteado en el original, así que se copia y se completa con las riskPaths de `docs/PLAN.md` §5.1 y el prefijo de rama:

```powershell
node -e "const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));m.workspaces[0].riskPaths=['prisma/migrations/**','src/auth/**','src/acl/**'];m.integration={branchPrefix:'feature/'};fs.writeFileSync('.claude/harness.json',JSON.stringify(m,null,2)+'\n')" "$PDV\academico\api-academico\.claude\harness.json"
node "$PDV\agentic-harness\plugins\arnes\scripts\lib\manifest.js" validate
git add .claude/harness.json
git commit -m "feature(arnes): adopta el manifiesto del arnés con riskPaths y prefijo de rama"
```

En `main`, `.claude/settings.json` no engancha el `git-guard.js` viejo: ese hook llegó en la rama de trabajo del original. Si tu `main` sí lo trae, quítalo antes de seguir (§8).

## 2. Línea base de tests

```powershell
node "$PDV\agentic-harness\plugins\arnes\scripts\test-baseline.js" capture api-academico
git add tests/baseline.json
git commit -m "gates: línea base de tests de api-academico"
```

Esperado, en menos de dos minutos:

```
línea base de api-academico en <PDV>\agentic-harness\.tmp\api-academico\tests\baseline.json: 95 spec(s), 953 pasan, 0 fallan, 0 saltados, HEAD <hash>
Commitéala con el prefijo gates: en el asunto.
```

Los conteos son los de `main` el 2026-10-19. Si `main` avanzó, cambian.

## 3. El cambio pequeño

En `src/modules/configuracion/configuracion.service.ts`, `findByAnio` recorta el año antes de buscar:

```ts
    return this.configuracionRepository.findByAnio(anio.trim());
```

En `src/modules/configuracion/configuracion.service.spec.ts`, al final del `describe('findByAnio')`, un test nuevo:

```ts
    it('debe buscar el año académico sin espacios alrededor', async () => {
      const mockAnioResult: Pick<IConfiguracion, 'id'> = { id: 1 };
      configuracionRepository.findByAnio.mockResolvedValue(mockAnioResult);

      await service.findByAnio(' 2026 ');

      expect(configuracionRepository.findByAnio).toHaveBeenCalledWith('2026');
    });
```

No hay archivos nuevos, así que verify no debería lanzar test-writer.

## 4. /arnes:verify

Abre la sesión en el clon y acepta el diálogo de confianza de la carpeta:

```powershell
cd $CLON
claude --plugin-dir "$PDV\agentic-harness\plugins\arnes"
```

Prompt: `/arnes:verify`

Esperado, primera corrida: **rojo por el lint**. El spec ya traía en `main` dos líneas de más de 80 columnas (43 y 55), y lo que se lintea es el archivo tocado entero:

```
  base       <hash> (--base HEAD) · 2 tocado(s), 2 de código
  typecheck  ok · sin diagnósticos nuevos (base 0, ahora 0)
  lint       FALLA · exit 1
               43:46  error  Replace `mockConfiguracion,·mockConfigAnterior` with `…`  prettier/prettier
               55:64  error  Replace `mockConfiguracion` with `…`  prettier/prettier
  tests      ok · 1 spec(s) · 7 pasan, 0 fallan, 0 saltados · base 6 pasan, 0 fallan, 0 saltados
```

Además:
- **Sin bandera:** Claude dice que no escribió la bandera y que no corrigió nada.
- **Sin test-writer:** `test-select --missing` no listó archivos.
- **Timeline:** queda `verify fin fail`.

Parte esas dos líneas como pide Prettier, a mano y sin `--fix`. La de la línea 43 queda así, y la 55 igual:

```ts
      const mockConfigs: IConfiguracion[] = [
        mockConfiguracion,
        mockConfigAnterior,
      ];
```

Prompt otra vez: `/arnes:verify`. Esperado: **verde, con la bandera escrita**:

```
  lint       ok · 2 archivo(s)
  tests      ok · 1 spec(s) · 7 pasan, 0 fallan, 0 saltados · base 6 pasan, 0 fallan, 0 saltados
resultado: VERDE. Verde significa que cumple convenciones y compila/testea; nunca que sea correcto en el negocio.
bandera pass para api-academico en <PDV>\agentic-harness\.tmp\api-academico\.tmp\harness\gate\api-academico.json
```

El reporte cierra con la frase de que verde significa que cumple convenciones y compila/testea, nunca que sea correcto en el negocio.

## 5. /arnes:review

Prompt: `/arnes:review`

Esperado:
1. **La entrada:** `review.js input` imprime `api-academico: 2 tocado(s) · sin riskPaths tocadas`, `plan: no hay` y la ruta de `input.md`.
2. **El agente:** se lanza `arnes:reviewer` una sola vez. Lee `input.md`, la regla de tests y los dos archivos, con Read y Grep, sin Bash.
3. **El reporte:** hallazgos por archivo con los bloqueantes primero, y como última línea `BLOQUEANTES: <n>`. Sin riskPaths tocadas, la frase de revisión humana no aparece. Sin plan, una línea dice que no hay criterios.
4. **La marca:** `review.js mark --blockers <n>`.

El 2026-10-19 el reviewer dio un bloqueante. Puede volver a darlo, porque el texto lo escribe el modelo:

```
- BLOQUEANTE [línea 99] · .claude/rules/academico-testing-standard.md §4 Data Management ("Never inline entity data in specs. Always use common/mocks.") · …
```

También dio una sugerencia de fondo: el `trim()` no llega a producción, porque `procesar-ficha.service.ts:43` llama directo al repositorio.

Si hay bloqueantes:
1. **Ship se niega.** En PowerShell, `node "$PDV\agentic-harness\plugins\arnes\scripts\ship.js" check` dice `NO LISTO` con `la revisión encontró 1 bloqueante(s)`.
2. **El arreglo** es usar el mock del repo:
   ```ts
      const mockAnioResult: Pick<IConfiguracion, 'id'> = {
        id: mockConfiguracion.id,
      };
   ```
3. **Al guardar,** `ship.js check` dice además que la bandera venció y que la revisión no es del árbol actual.
4. **Repite** `/arnes:verify` (verde, bandera nueva) y `/arnes:review` hasta `BLOQUEANTES: 0`.

## 6. /arnes:ship --solo-commit

Prompt: `/arnes:ship --solo-commit`

Esperado:
1. **`ship.js check`:**
   ```
       bandera: vigente
       revisión: revisión hecha, sin bloqueantes
       riskPaths tocadas: ninguna
       línea base de tests: no cambia
       convención: sin commitlint · CLAUDE.md no hay
       últimos asuntos de origin/main:
         feature(changelog): corrige longitud de líneas para pasar lint de CI
         …
   worktrees abiertos del issue: ninguno (el ledger de worktrees llega en la segunda mitad de la fase 3)
   orden de commit: api-academico
   prefijo de rama: feature/ (integration.branchPrefix)
   rama propuesta: feature/prueba-arnes-3a (la actual)
   resultado: LISTO
   ```
2. **La rama:** `ship.js branch` → `api-academico: reutiliza feature/prueba-arnes-3a (ya es la actual)`.
3. **El stage:** `ship.js stage api-academico` → los dos archivos en el stage.
4. **El commit:** uno solo, con la forma de los asuntos del repo (`feature(configuracion): …`), y después `git log -1 --stat`. El guard lo deja pasar porque la bandera está vigente.
5. **Sin push ni MR:** Claude lo dice y termina.

Comprueba en PowerShell:

```powershell
git log --oneline -4          # el commit de ship, el gates: y el de adopción sobre main
git status --short            # vacío
node "$PDV\agentic-harness\plugins\arnes\scripts\lib\timeline.js" print
```

La timeline lista las corridas de verify, review y ship. Al final van la duración por etapa y la línea `por etapa:`.

## 7. Opcional: lo que tiene que ponerse rojo

- **Un test saltado:**
  1. Cambia el `it(` del test nuevo por `it.skip(`.
  2. Corre `/arnes:verify`. Esperado:
     ```
       tests      FALLA · 1 spec(s) · 6 pasan, 0 fallan, 1 saltados · base 6 pasan, 0 fallan, 0 saltados
                  línea base: hay más tests saltados que en la base (1 > 0)
                  línea base: salto no declarado en la base: src/modules/configuracion/configuracion.service.spec.ts › ConfiguracionService › findByAnio › debe buscar el año académico sin espacios alrededor
     ```
  3. Deshazlo con `git checkout -- src/modules/configuracion/configuracion.service.spec.ts`.
- **Un test borrado:** borra cualquier `it(` de un spec y corre `/arnes:verify`. Esperado: `línea base: hay menos tests que en la base`.
- **Commit con la bandera vencida:** después del commit de ship, el HEAD cambió. Pide a Claude `git commit --allow-empty -m x`. Esperado: el guard lo niega con `HEAD cambió desde la verificación`.
- **La base y los tests nuevos:** la base dice 6 para el spec aunque ahora tiene 7 tests. El test nuevo no queda protegido hasta recapturar la base con un commit `gates:`. Por eso verify, con un test de más, agrega la nota `hay 1 test(s) más que en la base`.

## 8. Limpieza

```powershell
cd $PDV\agentic-harness
Remove-Item -Recurse -Force $CLON
git status --short             # nada: .tmp/ está en el .gitignore del arnés
```

El `node_modules` del clon salió de `npm ci`: es una carpeta propia, no un enlace al original, así que borrarlo no toca el original.

## Qué reportar

Por cada paso, si salió como está escrito. Si no salió así, el texto exacto que viste. No son fallos:
- conteos distintos porque `main` avanzó;
- que el reviewer redacte distinto o dé otros hallazgos;
- que verify salga verde a la primera si `main` ya no trae las dos líneas largas.

Sí son fallos:
- una bandera escrita con un paso en rojo;
- un reviewer con Bash o que edite archivos;
- ship que commitee sin bandera vigente o con bloqueantes;
- un push.

## Resultado

2026-10-19, en el clon `.tmp/api-academico`, con Claude Code 2.1.304 y el plugin cargado por `--plugin-dir`. Las skills corrieron en modo `-p` con el stream completo guardado. Las corridas reales fueron las de esta guía, en este orden:
1. `/arnes:verify`, rojo por el lint, sin bandera (96 s, $0.31).
2. `/arnes:verify`, verde, con la bandera (48 s, $0.12).
3. `/arnes:review`, con 1 bloqueante: el dato inline (67 s, $0.57).
4. `/arnes:verify`, verde (55 s, $0.20).
5. `/arnes:review`, con 0 bloqueantes (36 s, $0.31).
6. `/arnes:ship --solo-commit`, que creó `335f1cf feature(configuracion): recorta espacios del año académico antes de buscarlo` (33 s, $0.36).

La timeline del clon cerró con `por etapa: verify 2m20s · review 1m09s · ship 15s`. No hubo push: la URL de push del clon está anulada, y `git push` estaba además denegado en la sesión.

Dos correcciones salieron de esta corrida y están en el arnés:
- **El reviewer:** escribía `REVISIÓN HUMANA OBLIGATORIA: no aplica` sin riskPaths tocadas. Ya no la menciona cuando no corre.
- **Las skills:** el modelo encadenaba `echo "exit=$?"` a los scripts, y eso pedía un permiso aparte. Ahora cada comando va solo.

Falta que repitas los pasos 3 a 6 en una sesión interactiva y lo confirmes.
