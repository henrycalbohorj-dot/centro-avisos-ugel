# Centro de avisos · UGEL Chincha

Vigila las apps del servidor y publica avisos para la TV y, más adelante, para Silvanas.
Solo LEE: usa el usuario de PostgreSQL `avisos`, que únicamente ve dos vistas sin datos sensibles
(sin DNI, nombres de trabajadores, montos ni contraseñas).

| Qué vigila | Cada | Avisos |
|---|---|---|
| Tickets (`soporte_ti`) | 5 s | nuevo, sin atender a los 15/30/60 min, tomado por un técnico, cerrado |
| Créditos (`calculadora_prestamos`) | 10 s | nuevas solicitudes, solicitudes evaluadas |
| IP Libres | 20 s | IP duplicada, IP repetida en el inventario, DHCP sin enviar datos |

- Tablero para la TV: `http://IP_DEL_SERVIDOR:8095`
- Avisos en vivo (para Silvanas): `http://IP_DEL_SERVIDOR:8095/api/stream` (Server-Sent Events)
- Últimos avisos: `/api/eventos` · Resumen: `/api/resumen` · Prueba de voz (desde el servidor): `curl localhost:8095/api/prueba`

`config.json`: horario con voz (fuera de horario los avisos salen sin voz), qué avisos se dicen en voz alta y los minutos de recordatorio.
Tras cambiarlo: `sudo systemctl restart centro-avisos`. Registros: `journalctl -u centro-avisos -f`.

Para agregar otra app: una vista de solo lectura en `avisos.sql` y una función `revisarXxx()` en `server.js`.
