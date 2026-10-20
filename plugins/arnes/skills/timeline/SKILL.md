---
name: timeline
description: Mostrar la cronología del arnés y cuánto duró cada etapa, desde .tmp/harness/timeline.jsonl; funciona sin arnes-ui.
---

# arnes:timeline

1. Corre `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/timeline.js" print` desde el directorio donde la persona abrió la sesión, con la ruta entre comillas.
2. Muestra la salida tal cual, en un bloque de código. No la resumas ni la reordenes: es el registro que escriben las skills y los hooks.
3. Si sale con 2, di el motivo (no hay manifiesto) y termina.
