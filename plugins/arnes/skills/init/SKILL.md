---
name: init
description: Genera y valida el manifiesto .claude/harness.json de un proyecto o de una carpeta multi-repo; con --check comprueba el mínimo de adopción.
argument-hint: "[--check]"
disable-model-invocation: true
---

# arnes:init

Esqueleto de la fase 0. Detectar workspaces, escribir el borrador del manifiesto, validarlo contra `schema/harness.schema.json` y correr `--check` con `adoption-check.js` llega en la fase 1.

Mientras tanto, responde que `arnes:init` todavía no está implementado y no crees ni modifiques ningún archivo.
