# Centro de avisos · UGEL Chincha

Servicio que **vigila las apps del servidor y anuncia por voz** en una TV del Área de Informática: tickets nuevos o sin atender, solicitudes de crédito y problemas de red. También expone los avisos en tiempo real (SSE) para el asistente virtual **Silvanas**.

**Stack:** Node.js 18+ sin dependencias · `psql` · `edge-tts` (voz neuronal es-PE) · systemd.

## Cómo se integra

| Fuente | Cómo la lee | Avisos |
|---|---|---|
| [Soporte T.I.](https://github.com/henrycalbohorj-dot/soporte-ti-ugel) | vista `avisos_tickets` (usuario PostgreSQL `avisos`, solo lectura) | nuevo, sin atender 15/30/60 min, asignado, cerrado |
| [Calculadora / Solicitudes](https://github.com/henrycalbohorj-dot/calculadora-prestamos-ugel) | vista `avisos_solicitudes` | nueva solicitud, evaluada |
| [IP Libres](https://github.com/henrycalbohorj-dot/ip-libres-ugel) | API HTTP local `:8090` | IP duplicada, IP repetida en inventario, DHCP sin datos |

El usuario `avisos` **solo puede leer esas dos vistas**: no ve DNI, nombres de trabajadores, montos ni contraseñas.

```sql
CREATE ROLE avisos LOGIN;
\c soporte_ti
GRANT SELECT ON avisos_tickets TO avisos;
\c calculadora_prestamos
GRANT SELECT ON avisos_solicitudes TO avisos;
```

## Endpoints

- `/` tablero para la TV (`tv.html`, con el mapa 3D de IP Libres de fondo)
- `/api/stream` avisos en vivo (Server-Sent Events) · `/api/eventos` últimos avisos · `/api/resumen`

## Instalación

```bash
pipx install edge-tts
sudo useradd -r -s /usr/sbin/nologin avisos
sudo mkdir /opt/centro-avisos && sudo cp -r . /opt/centro-avisos
sudo cp config.example.json /opt/centro-avisos/config.json
sudo chown -R avisos: /opt/centro-avisos
sudo cp centro-avisos.service /etc/systemd/system/ && sudo systemctl enable --now centro-avisos
```

---
Desarrollado por **Ing. Henry Braulio Pachas Dávalos** · Área de Informática, UGEL Chincha.
