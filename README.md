# agentic-harness

Arnés multi-proyecto para Claude Code: un marketplace con el plugin `arnes` y dos mods opcionales, `arnes-ui` (interfaz) y `arnes-mod` (comportamiento). Hace que cualquier sesión, en cualquier proyecto, siga el mismo flujo (plan → build → verify → review → ship) con verificación determinista y revisión humana obligatoria en zonas de riesgo. El diseño completo está en [docs/PLAN.md](docs/PLAN.md).

Estado: fase 3 cerrada, versión 0.5.0 (tag `v0.5.0`); la prueba manual está en `docs/PRUEBA-FASE-3.md`. Sigue el piloto (fase 4). Ya existen:
- los manifiestos, uno por repo y una composición por carpeta multi-repo;
- los scripts deterministas y los hooks clásicos;
- las diez skills: `/arnes:init`, `plan`, `build`, `verify`, `review`, `ship`, `worktree`, `memory`, `sync` y `timeline`;
- los cuatro agentes: `dev`, `reviewer`, `test-writer` y `test-runner`;
- los worktrees por issue con su registro, la línea base de tests commiteada y el aviso de sesión concurrente;
- el mod `arnes-ui`.

Falta `arnes-mod` (fase 5).

## Principios

1. Cada pieza existe porque el modelo no lo hace solo. Cuando un modelo nuevo lo haga, la pieza se quita.
2. Lo que debe cumplirse siempre va a una herramienta (lint, tsc, tests, hook, CI, aprobación en el host git). Lo que requiere juicio va en prosa corta. Lo demás se borra.
3. Nada del stack queda cableado en el arnés: todo lo específico se lee del manifiesto del proyecto y de su `CLAUDE.md`.
4. El verde del arnés significa "cumple convenciones y compila/testea", nunca "es correcto en el negocio". Se dice así en cada reporte.
5. El plugin funciona completo sin el mod. El mod es opcional y delgado.
6. Presupuesto: ninguna skill supera ~80 líneas; ningún agente supera ~120; el `CLAUDE.md` raíz de un proyecto no supera 200.

## Instalación

El repo vive en GitLab. El formato corto `owner/repo` siempre apunta a github.com, así que se instala con la URL completa y el tag al final:

```
claude plugin install arnes --marketplace https://gitlab.com/preupdv/apps/agentic-harness.git#vX.Y.Z
claude plugin install arnes-ui@agentic-harness
claude plugin install arnes-mod@agentic-harness
```

El primer comando añade el marketplace `agentic-harness` fijado a ese tag (scope `user`) e instala `arnes`. Los otros dos son opcionales e independientes; `arnes-mod` declara `arnes` como dependencia. Claude Code clona con `git` sin preguntar credenciales: la credencial de GitLab tiene que estar guardada de antemano (Git Credential Manager) o, por SSH, usar `git@gitlab.com:preupdv/apps/agentic-harness.git#vX.Y.Z` con la clave cargada en el agente.

Para fijar la versión en un repo de proyecto, en `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agentic-harness": {
      "source": { "source": "git", "url": "https://gitlab.com/preupdv/apps/agentic-harness.git", "ref": "vX.Y.Z" }
    }
  },
  "enabledPlugins": { "arnes@agentic-harness": true }
}
```

El auto-update de un marketplace de terceros viene apagado y se deja así.

Cambiar de tag, para subir o para volver atrás, es quitar el marketplace y añadirlo en el otro tag. `claude plugin marketplace remove agentic-harness` desinstala los plugins que vinieron de él, así que después se reinstalan con los comandos de arriba. Desinstalar un plugin suelto: `claude plugin uninstall <nombre>@agentic-harness`.

Probar sin instalar, desde la raíz del repo:

```
claude plugin validate --strict plugins/arnes
claude --plugin-dir ./plugins/arnes
claude --plugin-dir ./plugins/arnes --plugin-dir ./plugins/arnes-ui
claude plugin test plugins/arnes-ui
```

## Permisos recomendados

Los hooks no piden permiso: corren fuera del sistema de permisos. Lo que sí pide confirmación son los comandos que el modelo lanza por Bash o PowerShell: los scripts del plugin que invocan las skills, git de lectura y los comandos de test del manifiesto. Sin estas reglas el arnés funciona igual, pero pregunta. Van en `~/.claude/settings.json`, o en `settings.json` del directorio que indique `CLAUDE_CONFIG_DIR`:

```json
{
  "permissions": {
    "allow": [
      "Bash(node \"C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/*)",
      "PowerShell(node \"C:/Users/<usuario>/.claude/plugins/cache/agentic-harness/arnes/*)",
      "Bash(git status *)",
      "Bash(git diff *)",
      "Bash(git log *)",
      "Bash(git show *)",
      "Bash(git rev-parse *)",
      "Bash(git ls-files *)",
      "Bash(git merge-base *)",
      "Bash(npx tsc --noEmit *)",
      "Bash(npx tsc -p *)",
      "Bash(npx jest *)",
      "Bash(npx eslint *)",
      "PowerShell(npx jest *)",
      "PowerShell(npx eslint *)",
      "Bash(graphify query *)",
      "Bash(graphify explain *)",
      "Bash(graphify path *)",
      "Bash(glab issue view *)",
      "Bash(gh issue view *)"
    ],
    "ask": [
      "Bash(npx eslint *--fix*)",
      "PowerShell(npx eslint *--fix*)"
    ]
  }
}
```

Cómo leerlas (sintaxis de code.claude.com/docs/en/permissions):
- **El `*` admite cualquier texto, espacios incluidos, y lo que va antes se compara tal cual.** La ruta del plugin es la de la caché (`<config>/plugins/cache/<marketplace>/<plugin>/<versión>/`), con barras normales, porque Claude Code sustituye `${CLAUDE_PLUGIN_ROOT}` así también en Windows. El `*` después de `arnes/` cubre la versión y el script; un `..` dentro de la ruta escaparía de esa carpeta, así que la regla confía en que los comandos sean los de las skills. Con `CLAUDE_CONFIG_DIR` la raíz cambia (por ejemplo `.claude-pdv`), y con `claude --plugin-dir` la ruta es la del repo del arnés.
- **Las formas de git de lectura sin `cd` ni `-C` ya corren sin preguntar.** Estas reglas cubren las que no: `git -C <ruta> status` no las cumple, porque el patrón compara el texto desde el inicio.
- **`Bash(npx eslint *)` también dejaría pasar un `--fix`.** Por eso va la regla `ask`, que se evalúa antes que `allow` y obliga a preguntar.
- **graphify y la lectura del issue son de solo lectura.** `/arnes:plan` y `/arnes:memory recall` consultan graphify con `query`, `explain` y `path`, y plan lee el issue con `glab issue view` o `gh issue view`. Los scripts nuevos de la fase 3 ya los cubre la regla de `node` sobre la carpeta del plugin. `git commit` y `git push` quedan fuera a propósito: los corre `/arnes:ship`, que pide confirmación antes de cualquier push.
- **Los comandos de test son los de los manifiestos de academico.** Ajústalos a los `commands` de cada repo y no agregues comodines más amplios que el comando real.

## Versionado en dos capas

1. **Tag del repo `vX.Y.Z`** (semver). Es lo que el equipo fija: `#vX.Y.Z` en la instalación o `ref` en settings. Un tag cubre los tres plugins, y cada tag tiene su entrada en `CHANGELOG.md`.
2. **`version` en el `plugin.json` de cada plugin**, igual al tag en los tres. Claude Code compara este campo para decidir si hay versión nueva: si el código cambia y el campo no, nadie recibe el cambio. Las entradas de `marketplace.json` no llevan `version`; si la llevaran, ganaría `plugin.json` y `validate` avisaría del desfase. Pushear código sin subir `version` no llega a nadie: Claude Code compara ese campo, no los commits.

No se usan los tags por plugin `<nombre>--v<versión>`: solo hacen falta para resolver rangos de versión entre dependencias, y `arnes-mod` depende de `arnes` sin rango.

## Matriz de compatibilidad

CLI y arnés se suben juntos, nunca uno solo. El CI valida contra la versión del CLI fijada en `.gitlab-ci.yml`.

| Tag del arnés | Claude Code probado | Node probado | Notas |
|---|---|---|---|
| v0.1.0 | 2.1.303 | 24 | Fase 0: marketplace y tres plugins vacíos; `/arnes:init` es un esqueleto |
| v0.2.0 (sin etiquetar) | 2.1.303 | 24 | Fase 1: schema de los dos niveles de manifiesto, scripts deterministas con tests (`node --test`) y `/arnes:init` completa; probado en academico (3 repos) y renova365 (2 repos) |
| v0.3.0 (sin etiquetar) | 2.1.303 | 24 | Fase 2: hooks clásicos (guard, after-edit, session-start, prompt-context, stop-gate, worktree-remove) con tests por stdin; la prueba manual en una sesión interactiva está en `docs/PRUEBA-FASE-2.md`, hecha en api-academico el 2026-10-19 |
| v0.4.0 (sin etiquetar) | 2.1.303 (tipos de la API de mods) y 2.1.304 (`validate` y `plugin test`) | 24 | Fase 2b: mod `arnes-ui` (banda, panel con `/arnes-panel`, status, toasts) con tests de `claude plugin test`, y `/arnes:timeline` en el plugin base; la prueba manual está en `docs/PRUEBA-FASE-2B.md`, hecha y repetida en api-academico y desde la raíz de academico el 2026-10-19 con 2.1.304; fase cerrada |
| v0.5.0 | 2.1.304 | 24 | Fase 3: plan, build, verify, review, ship, worktree, memory y sync, los agentes dev, reviewer, test-writer y test-runner, el registro de worktrees, la línea base de tests y el aviso de sesión concurrente. Probada de punta a punta sobre un clon de api-academico el 2026-10-20, con `claude -p` y en una sesión interactiva; la prueba manual está en `docs/PRUEBA-FASE-3.md`; fase cerrada |
