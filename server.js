// Centro de avisos UGEL Chincha: vigila las apps del servidor (solo lectura) y publica avisos
// para Silvanas y la TV. Sin dependencias: Node 18+ y el cliente psql.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFile } = require('child_process');

const DIR = __dirname;
const leer = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch { return d; } };
const CFG = Object.assign({
  puerto: 8095,
  ipLibres: 'http://127.0.0.1:8090',
  bases: { tickets: 'soporte_ti', creditos: 'calculadora_prestamos' },
  cada: { tickets: 5, creditos: 10, red: 20 },           // segundos entre revisiones
  sinAtenderMin: [15, 30, 60],                            // recordatorios de tickets pendientes sin técnico
  horario: { dias: [1, 2, 3, 4, 5], desde: '08:00', hasta: '17:30' }, // fuera de este horario: avisos sin voz
  voz: { ticketNuevo: true, sinAtender: true, asignado: false, cerrado: false, creditoNuevo: true, creditoEvaluado: false, red: true },
  guardar: 500,
  mapa: 'http://127.0.0.1:8090/mapa?tv&limpio',     // mapa 3D que se ve de fondo en la TV
  mensajeCadaMin: 5,                                   // Silvanas dice un mensaje de tecnología cada X minutos
  groq: { key: '', modelo: 'llama-3.3-70b-versatile' }, // con clave: mensajes nuevos generados por IA; sin clave: banco propio
  // Voz humana de Silvanas: voces neuronales de Microsoft (edge-tts). Camila = español de Perú.
  tts: { voz: 'es-PE-CamilaNeural', velocidad: '+0%', tono: '+0Hz', bin: '' }
}, leer('config.json', {}));

let EST = leer('estado.json', { ultId: 0, eventos: [], tickets: {}, creditos: {}, red: {} });
EST.eventos = EST.eventos || [];
const guardar = () => fs.writeFile(path.join(DIR, 'estado.json'), JSON.stringify(EST), () => {});
const clientes = new Set();

// ---------- Publicar un aviso ----------
const hhmm = d => d.getHours() * 60 + d.getMinutes(), aMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
function enHorario(d = new Date()) {
  const h = CFG.horario; if (!h) return true;
  return h.dias.includes(d.getDay()) && hhmm(d) >= aMin(h.desde) && hhmm(d) <= aMin(h.hasta);
}
function avisar(app, tipo, nivel, titulo, voz, detalle, conVoz) {
  const e = { id: ++EST.ultId, ts: Date.now(), app, tipo, nivel, titulo, detalle: detalle || '', voz: conVoz && enHorario() ? voz : '' };
  EST.eventos.push(e); if (EST.eventos.length > CFG.guardar) EST.eventos = EST.eventos.slice(-CFG.guardar);
  guardar();
  if (e.voz) vozMp3(e.voz).catch(() => {}); // deja el audio listo antes de que la TV lo pida
  const msg = `id: ${e.id}\nevent: aviso\ndata: ${JSON.stringify(e)}\n\n`;
  for (const r of clientes) r.write(msg);
  console.log(new Date().toLocaleString('es-PE'), `[${app}] ${titulo}`);
}

// ---------- Consultas de solo lectura con psql (usuario "avisos") ----------
// En Ubuntu "psql" es un intermediario que necesita leer la configuración del clúster; usamos el psql real.
const PSQL = CFG.psql || (() => {
  try { const v = fs.readdirSync('/usr/lib/postgresql').filter(x => /^\d+$/.test(x)).sort((a, b) => b - a);
    for (const x of v) { const f = `/usr/lib/postgresql/${x}/bin/psql`; if (fs.existsSync(f)) return f; } } catch {}
  return 'psql';
})();
const PGARGS = ['-h', CFG.pgHost || '/var/run/postgresql', '-p', String(CFG.pgPuerto || 5432)];
function consulta(db, sql) {
  return new Promise((ok, mal) => {
    execFile(PSQL, [...PGARGS, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-c', `SELECT coalesce(json_agg(q), '[]') FROM (${sql}) q`],
      { timeout: 15000, maxBuffer: 8e6 }, (err, out, se) => err ? mal(new Error((se || err.message).trim())) : ok(JSON.parse(out.trim() || '[]')));
  });
}
const salud = {}; // estado de cada conector, para /api/salud
async function vigilar(nombre, fn) {
  try { await fn(); if (salud[nombre] && salud[nombre].error) console.log(`[${nombre}] conexión recuperada`); salud[nombre] = { ok: Date.now() }; }
  catch (e) { if (!salud[nombre] || !salud[nombre].error) console.error(`[${nombre}]`, e.message); salud[nombre] = { error: e.message, ts: Date.now() }; }
}
const numTk = c => { const m = /(\d+)$/.exec(c || ''); return m ? 'número ' + Number(m[1]) : (c || ''); };
const n = v => Number(v) || 0;

// ---------- Tickets (Soporte T.I.) ----------
async function revisarTickets() {
  const T = EST.tickets, db = CFG.bases.tickets;
  const [{ ahora }] = await consulta(db, 'SELECT now()::timestamp AS ahora');
  if (!T.ultId) { // primera vez: solo toma referencia, no anuncia lo viejo
    const [r] = await consulta(db, 'SELECT coalesce(max(id_ticket),0) AS m FROM avisos_tickets');
    const rec = {}; // los pendientes que ya existían no se anuncian de golpe al instalar
    for (const t of await consulta(db, `SELECT id_ticket, floor(extract(epoch FROM (now()::timestamp - fecha_creacion)) / 60) AS min FROM avisos_tickets WHERE estado = 'pendiente' AND id_tecnico IS NULL`))
      rec[t.id_ticket] = CFG.sinAtenderMin.filter(m => t.min >= m).pop() || 0;
    Object.assign(T, { ultId: n(r.m), desde: ahora, recordados: rec }); guardar(); return;
  }
  const desde = String(T.desde).replace(/[^0-9T:. -]/g, '');
  // 1. Tickets nuevos
  for (const t of await consulta(db, `SELECT * FROM avisos_tickets WHERE id_ticket > ${n(T.ultId)} ORDER BY id_ticket`)) {
    T.ultId = Math.max(T.ultId, t.id_ticket);
    const alta = /alta|urgente|cr[ií]tica/i.test(t.prioridad || '');
    avisar('tickets', 'nuevo', alta ? 'urgente' : 'aviso', `Nuevo ticket ${t.codigo}${t.area ? ' · ' + t.area : ''}`,
      `Nuevo ticket ${numTk(t.codigo)}${t.area ? ' del área de ' + t.area : ''}: ${t.titulo}.${alta ? ' Prioridad alta.' : ''}`,
      t.titulo + (t.prioridad ? ` · Prioridad ${t.prioridad}` : ''), CFG.voz.ticketNuevo);
  }
  // 2. Tomados por un técnico y cerrados desde la última revisión
  for (const t of await consulta(db, `SELECT * FROM avisos_tickets WHERE fecha_asignacion > '${desde}' OR fecha_cierre > '${desde}' ORDER BY coalesce(fecha_cierre, fecha_asignacion)`)) {
    if (['completado', 'cancelado', 'rechazado'].includes(t.estado) && t.fecha_cierre > desde)
      avisar('tickets', 'cerrado', 'info', `Ticket ${t.codigo} ${t.estado}`, `Ticket ${numTk(t.codigo)} ${t.estado}.`, t.titulo, CFG.voz.cerrado);
    else if (t.estado === 'en_atencion')
      avisar('tickets', 'asignado', 'info', `${t.tecnico || 'Un técnico'} atiende ${t.codigo}`, `${t.tecnico || 'Un técnico'} está atendiendo el ticket ${numTk(t.codigo)}.`, t.titulo, CFG.voz.asignado);
  }
  // 3. Pendientes sin técnico: recordatorios a los 15, 30 y 60 minutos
  const pend = await consulta(db, `SELECT *, floor(extract(epoch FROM (now()::timestamp - fecha_creacion)) / 60) AS min FROM avisos_tickets WHERE estado = 'pendiente' AND id_tecnico IS NULL`);
  const rec = T.recordados || (T.recordados = {}), vivos = new Set();
  for (const t of pend) {
    vivos.add(String(t.id_ticket));
    const hito = CFG.sinAtenderMin.filter(m => t.min >= m).pop();
    if (hito && (rec[t.id_ticket] || 0) < hito) {
      rec[t.id_ticket] = hito;
      avisar('tickets', 'sinAtender', hito >= 60 ? 'urgente' : 'aviso', `${t.codigo} lleva ${hito} min sin atender`,
        `Atención: el ticket ${numTk(t.codigo)}${t.area ? ' de ' + t.area : ''} lleva ${hito} minutos sin atender.`, t.titulo, CFG.voz.sinAtender);
    }
  }
  for (const k of Object.keys(rec)) if (!vivos.has(k)) delete rec[k];
  T.pendientes = pend.length; T.desde = ahora;
  T.lista = pend.sort((a, b) => b.min - a.min).slice(0, 5).map(t => ({ codigo: t.codigo, area: t.area, titulo: t.titulo, min: n(t.min) }));
  guardar();
}

// ---------- Calculadora: solicitudes de crédito (sin nombres ni montos) ----------
async function revisarCreditos() {
  const C = EST.creditos, db = CFG.bases.creditos;
  const [{ ahora }] = await consulta(db, 'SELECT now() AS ahora');
  if (!C.ultId) {
    const [r] = await consulta(db, 'SELECT coalesce(max(id),0) AS m FROM avisos_solicitudes');
    Object.assign(C, { ultId: n(r.m), desde: ahora }); guardar(); return;
  }
  const desde = String(C.desde).replace(/[^0-9T:.+ -]/g, '');
  const nuevas = await consulta(db, `SELECT id FROM avisos_solicitudes WHERE id > ${n(C.ultId)}`);
  const [{ p }] = await consulta(db, `SELECT count(*) AS p FROM avisos_solicitudes WHERE estado = 'PENDIENTE'`);
  if (nuevas.length) {
    C.ultId = Math.max(...nuevas.map(x => x.id));
    const k = nuevas.length;
    avisar('creditos', 'nuevo', 'aviso', k === 1 ? 'Nueva solicitud de crédito' : `${k} nuevas solicitudes de crédito`,
      (k === 1 ? 'Llegó una nueva solicitud de crédito para evaluar.' : `Llegaron ${k} nuevas solicitudes de crédito para evaluar.`) + (n(p) > k ? ` En total hay ${p} pendientes.` : ''),
      `${p} pendientes de evaluación`, CFG.voz.creditoNuevo);
  }
  const ev = await consulta(db, `SELECT estado, count(*) AS c FROM avisos_solicitudes WHERE evaluado_en > '${desde}' GROUP BY estado`);
  if (ev.length) {
    const txt = ev.map(x => `${x.c} ${String(x.estado).toLowerCase()}`).join(', ');
    avisar('creditos', 'evaluado', 'info', `Solicitudes evaluadas: ${txt}`, `Se evaluaron solicitudes de crédito: ${txt}.`, `${p} siguen pendientes`, CFG.voz.creditoEvaluado);
  }
  C.pendientes = n(p); C.desde = ahora; guardar();
}

// ---------- IP Libres: alertas de red ----------
async function revisarRed() {
  const R = EST.red, r = await fetch(CFG.ipLibres + '/api/estado', { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('IP Libres respondió ' + r.status);
  const j = await r.json(), vistas = new Set(R.vistas || []), primera = !R.vistas;
  for (const a of j.alertas || []) {
    if (vistas.has(a.id)) continue; vistas.add(a.id);
    if (primera) continue;
    const ip = a.ip ? a.ip.split('.').slice(-2).join('.') : '';
    const inv = String(a.id).startsWith('inv:');
    avisar('red', 'alerta', 'urgente', inv ? `IP ${a.ip} repetida en el inventario` : `IP ${a.ip} ${a.tipo === 'duplicada' ? 'duplicada en la red' : 'en conflicto'}`,
      inv ? `Alerta de red: la IP ${ip} está asignada a dos equipos en el inventario.` : `Alerta de red: dos equipos están usando la IP ${ip} al mismo tiempo.`,
      (a.equipos || []).map(e => e.host || e.mac).filter(Boolean).join(' / '), CFG.voz.red);
  }
  R.vistas = [...vistas].slice(-300);
  // El servidor DHCP manda su lista cada 5 min: si deja de llegar, avisa una vez
  const viejo = j.dhcp && Date.now() - j.dhcp.ts > 20 * 60e3;
  if (viejo && !R.dhcpCaido && !primera) avisar('red', 'dhcp', 'aviso', 'El DHCP dejó de enviar datos', 'El servidor DHCP dejó de enviar su lista a IP Libres hace más de 20 minutos.', 'Revisar la tarea programada en SRVDCUCHINCHA', CFG.voz.red);
  if (!viejo && R.dhcpCaido) avisar('red', 'dhcp', 'info', 'El DHCP volvió a enviar datos', '', '', false);
  R.dhcpCaido = !!viejo;
  const segs = j.segmentos || [];
  R.resumen = { enLinea: segs.reduce((s, g) => s + g.ips.filter(x => x.on).length, 0), alertas: (j.alertas || []).length };
  guardar();
}

// ---------- Voz humana (edge-tts): MP3 en caché por texto ----------
const TTS = Object.assign({ voz: 'es-PE-CamilaNeural', velocidad: '+0%', tono: '+0Hz' }, CFG.tts);
const TTS_BIN = TTS.bin || [path.join(DIR, 'venv/bin/edge-tts'), '/usr/local/bin/edge-tts', '/usr/bin/edge-tts'].find(f => fs.existsSync(f)) || 'edge-tts';
const CACHE = path.join(DIR, 'voz-cache'); try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}
const enCurso = new Map();
function vozMp3(texto) {
  texto = String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (!texto) return Promise.reject(new Error('Sin texto'));
  const h = crypto.createHash('sha1').update([TTS.voz, TTS.velocidad, TTS.tono, texto].join('|')).digest('hex'), f = path.join(CACHE, h + '.mp3');
  if (fs.existsSync(f)) return Promise.resolve(f);
  if (enCurso.has(h)) return enCurso.get(h);
  const p = new Promise((ok, mal) => {
    const tmp = f + '.tmp.mp3';
    execFile(TTS_BIN, ['--voice', TTS.voz, `--rate=${TTS.velocidad}`, `--pitch=${TTS.tono}`, '--text', texto, '--write-media', tmp], { timeout: 25000 }, (err, _o, se) => {
      try { if (err || !fs.statSync(tmp).size) throw new Error((se || (err && err.message) || 'audio vacío').trim().split('\n').pop()); fs.renameSync(tmp, f); ok(f); }
      catch (e) { fs.rm(tmp, () => {}); console.error('[voz]', e.message); mal(e); }
    });
  }).finally(() => enCurso.delete(h));
  enCurso.set(h, p); return p;
}
setInterval(() => { // borra audios de más de 3 días
  fs.readdir(CACHE, (e, L) => { if (e) return; for (const x of L) { const f = path.join(CACHE, x); fs.stat(f, (e2, st) => { if (!e2 && Date.now() - st.mtimeMs > 3 * 864e5) fs.rm(f, () => {}); }); } });
}, 6 * 3600e3);

// ---------- Mensaje de tecnología cada X minutos: nunca repetido ----------
const BANCO = leer('mensajes.json', []);
const TEMAS = ['historia de la computación', 'ciberseguridad en la oficina', 'Python', 'JavaScript y la web', 'bases de datos', 'redes e internet',
  'inteligencia artificial', 'hardware y componentes', 'buenas prácticas de programación', 'Linux y software libre', 'Git y trabajo en equipo',
  'servidores y la nube', 'datos curiosos de la tecnología', 'productividad con la computadora', 'algoritmos explicados fácil', 'respaldos y cuidado de la información'];
const M = EST.mensajes || (EST.mensajes = { hist: [], iTema: 0, orden: [], i: 0 });
const norm = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function parecido(a, b) { const A = new Set(norm(a).split(' ').filter(w => w.length > 3)), B = new Set(norm(b).split(' ').filter(w => w.length > 3));
  if (!A.size || !B.size) return 0; let c = 0; for (const w of A) if (B.has(w)) c++; return c / Math.min(A.size, B.size); }
const repetido = t => M.hist.some(h => norm(h) === norm(t) || parecido(h, t) > 0.6);
async function conIA() {
  const g = CFG.groq; if (!g || !g.key) return null;
  const tema = TEMAS[M.iTema++ % TEMAS.length];
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { Authorization: 'Bearer ' + g.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: g.modelo || 'llama-3.3-70b-versatile', temperature: 1, max_tokens: 140, messages: [
      { role: 'system', content: 'Eres Silvanas, la asistente virtual de la UGEL Chincha, en Perú. Escribes UN solo mensaje breve que dirás en voz alta en una TV de oficina: un dato curioso, consejo o reflexión sobre tecnología o programación. Español peruano, cálido y natural, como lo diría una persona. Entre 15 y 35 palabras, una o dos oraciones, sin emojis, sin comillas, sin listas, sin saludos. Debe ser correcto y verificable; si no estás segura de un dato, mejor da un consejo práctico.' },
      { role: 'user', content: `Tema de hoy: ${tema}.\nNo repitas ni parafrasees ninguno de estos mensajes anteriores:\n${M.hist.slice(-25).map(h => '- ' + h).join('\n')}` }] }) });
  if (!r.ok) throw new Error('Groq respondió ' + r.status);
  return String((await r.json()).choices[0].message.content || '').trim().replace(/^["«“]+|["»”]+$/g, '').replace(/\s+/g, ' ');
}
function delBanco() {
  if (!BANCO.length) return null;
  const sig = () => { if (M.i >= M.orden.length) { M.orden = BANCO.map((_, i) => i).sort(() => Math.random() - 0.5); M.i = 0; } return BANCO[M.orden[M.i++]]; };
  for (let k = 0; k < BANCO.length * 2; k++) { const t = sig(); if (!repetido(t)) return t; }
  return sig(); // ya se dijo todo el banco: recién ahí se repite alguno
}
let mensajeSlot = null, generando = null;
async function mensajeActual() {
  const slot = Math.floor(Date.now() / (CFG.mensajeCadaMin * 60e3));
  if (mensajeSlot && mensajeSlot.slot === slot) return mensajeSlot;
  if (generando) return generando;
  generando = (async () => {
    let texto = null, fuente = 'banco';
    for (let k = 0; k < 3 && !texto; k++) {
      try { const t = await conIA(); if (t === null) break; if (t.length > 20 && !repetido(t)) { texto = t; fuente = 'ia'; } }
      catch (e) { console.error('[mensaje]', e.message); break; }
    }
    texto = texto || delBanco() || 'La tecnología es más útil cuando todos la usamos con cuidado.';
    M.hist.push(texto); M.hist = M.hist.slice(-1000); guardar();
    mensajeSlot = { slot, texto, fuente, siguiente: (slot + 1) * CFG.mensajeCadaMin * 60e3 };
    vozMp3(texto).catch(() => {});
    console.log(new Date().toLocaleString('es-PE'), `[mensaje ${fuente}] ${texto}`);
    return mensajeSlot;
  })().finally(() => { generando = null; });
  return generando;
}

// ---------- HTTP: tablero, eventos, stream en vivo ----------
const json = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(o)); };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(DIR, 'index.html')).pipe(res);
  }
  if (u.pathname === '/tv' || u.pathname === '/silvanas') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(DIR, 'tv.html')).pipe(res);
  }
  if (u.pathname === '/api/mensaje') { mensajeActual().then(m => json(res, 200, m), e => json(res, 500, { error: e.message })); return; }
  if (u.pathname === '/api/voz') {
    vozMp3(u.searchParams.get('t')).then(f => {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400', 'Content-Length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    }, e => json(res, 503, { error: 'Voz no disponible: ' + e.message }));
    return;
  }
  if (u.pathname === '/api/tv') return json(res, 200, { mapa: CFG.mapa, mensajeCadaMin: CFG.mensajeCadaMin });
  if (u.pathname === '/api/eventos') {
    const desde = Number(u.searchParams.get('desde')) || 0, lim = Math.min(200, Number(u.searchParams.get('n')) || 50);
    return json(res, 200, EST.eventos.filter(e => e.id > desde).slice(-lim));
  }
  if (u.pathname === '/api/resumen') return json(res, 200, {
    ticketsPendientes: EST.tickets.pendientes ?? null, pendientesLista: EST.tickets.lista || [], creditosPendientes: EST.creditos.pendientes ?? null,
    red: EST.red.resumen || null, enHorario: enHorario(), salud, ultimo: EST.ultId });
  if (u.pathname === '/api/salud') return json(res, 200, salud);
  if (u.pathname === '/api/stream') { // Silvanas y la TV se suscriben aquí (Server-Sent Events)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('retry: 5000\n\n');
    const desde = Number(req.headers['last-event-id'] || u.searchParams.get('desde')) || 0;
    for (const e of EST.eventos.filter(e => e.id > desde && desde)) res.write(`id: ${e.id}\nevent: aviso\ndata: ${JSON.stringify(e)}\n\n`);
    clientes.add(res); const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clientes.delete(res); });
    return;
  }
  // Prueba manual de voz/pantalla (solo desde el propio servidor)
  if (u.pathname === '/api/prueba' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    avisar('sistema', 'prueba', 'info', 'Aviso de prueba', 'Hola, soy el centro de avisos de la UGEL Chincha. Todo funciona correctamente.', 'Prueba manual', true);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'No existe' });
}).listen(CFG.puerto, () => {
  console.log(`Centro de avisos en http://0.0.0.0:${CFG.puerto} (psql: ${PSQL})`);
  const ciclo = (nombre, fn, s) => { const t = () => vigilar(nombre, fn).finally(() => setTimeout(t, s * 1000)); setTimeout(t, 1500); };
  ciclo('tickets', revisarTickets, CFG.cada.tickets);
  ciclo('creditos', revisarCreditos, CFG.cada.creditos);
  ciclo('red', revisarRed, CFG.cada.red);
});
