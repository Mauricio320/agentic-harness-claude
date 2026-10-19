# claude-harness

Arnés multi-proyecto para Claude Code: un marketplace con el plugin `arnes` y dos mods opcionales, `arnes-ui` (interfaz) y `arnes-mod` (comportamiento). Hace que cualquier sesión, en cualquier proyecto, siga el mismo flujo (plan → build → verify → review → ship) con verificación determinista y revisión humana obligatoria en zonas de riesgo. El diseño completo está en [docs/PLAN.md](docs/PLAN.md).

Estado: fase 0. Los plugins existen y validan, pero todavía no hacen nada.

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
claude plugin install arnes --marketplace https://gitlab.com/<grupo>/claude-harness.git#vX.Y.Z
claude plugin install arnes-ui@claude-harness
claude plugin install arnes-mod@claude-harness
```

El primer comando añade el marketplace `claude-harness` fijado a ese tag (scope `user`) e instala `arnes`. Los otros dos son opcionales e independientes; `arnes-mod` declara `arnes` como dependencia. Claude Code clona con `git` sin preguntar credenciales: la credencial de GitLab tiene que estar guardada de antemano (Git Credential Manager) o, por SSH, usar `git@gitlab.com:<grupo>/claude-harness.git#vX.Y.Z` con la clave cargada en el agente.

Para fijar la versión en un repo de proyecto, en `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-harness": {
      "source": { "source": "git", "url": "https://gitlab.com/<grupo>/claude-harness.git", "ref": "vX.Y.Z" }
    }
  },
  "enabledPlugins": { "arnes@claude-harness": true }
}
```

El auto-update de un marketplace de terceros viene apagado y se deja así.

Cambiar de tag, para subir o para volver atrás, es quitar el marketplace y añadirlo en el otro tag. `claude plugin marketplace remove claude-harness` desinstala los plugins que vinieron de él, así que después se reinstalan con los comandos de arriba. Desinstalar un plugin suelto: `claude plugin uninstall <nombre>@claude-harness`.

Probar sin instalar, desde la raíz del repo:

```
claude plugin validate --strict plugins/arnes
claude --plugin-dir ./plugins/arnes
```

## Versionado en dos capas

1. **Tag del repo `vX.Y.Z`** (semver). Es lo que el equipo fija: `#vX.Y.Z` en la instalación o `ref` en settings. Un tag cubre los tres plugins, y cada tag tiene su entrada en `CHANGELOG.md`.
2. **`version` en el `plugin.json` de cada plugin**, igual al tag en los tres. Claude Code compara este campo para decidir si hay versión nueva: si el código cambia y el campo no, nadie recibe el cambio. Las entradas de `marketplace.json` no llevan `version`; si la llevaran, ganaría `plugin.json` y `validate` avisaría del desfase. Pushear código sin subir `version` no llega a nadie: Claude Code compara ese campo, no los commits.

No se usan los tags por plugin `<nombre>--v<versión>`: solo hacen falta para resolver rangos de versión entre dependencias, y `arnes-mod` depende de `arnes` sin rango.

## Matriz de compatibilidad

CLI y arnés se suben juntos, nunca uno solo. El CI valida contra la versión del CLI fijada en `.gitlab-ci.yml`.

| Tag del arnés | Claude Code probado | Node probado | Notas |
|---|---|---|---|
| v0.1.0 (sin etiquetar) | 2.1.303 | 24 | Fase 0: marketplace y tres plugins vacíos; `/arnes:init` es un esqueleto |
