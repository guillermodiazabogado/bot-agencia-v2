require('dotenv').config();


const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const cron = require('node-cron');
const fs = require('fs');
const os = require('os');
const path = require('path');


const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;


const ASANA_TOKEN = process.env.ASANA_TOKEN;
const ASANA_PROJECT_GID = process.env.ASANA_PROJECT_GID;
const ASANA_NOTIFY_SECTION_GID = process.env.ASANA_NOTIFY_SECTION_GID;


const HORA_RESUMEN = process.env.HORA_RESUMEN || '07:30';
const CALENDAR_TIMEZONE = 'America/Argentina/Buenos_Aires';
const SCOPES = ['https://www.googleapis.com/auth/calendar'];


if (!TELEGRAM_TOKEN) throw new Error('Falta TELEGRAM_TOKEN');
if (!OPENAI_API_KEY) throw new Error('Falta OPENAI_API_KEY');
if (!ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY');


const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });


function escapeHtml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


function pad2(n) {
  return String(n).padStart(2, '0');
}


function formatoFechaISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}


function obtenerFechaRelativa(offsetDias) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDias);
  return formatoFechaISO(d);
}


function limpiarTexto(texto = '') {
  return String(texto).trim();
}


function esFechaISO(valor) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''));
}


function esHoraHHMM(valor) {
  return /^\d{2}:\d{2}$/.test(String(valor || ''));
}


function sumarMinutos(hora, minutos) {
  const [h, m] = hora.split(':').map(Number);
  const total = h * 60 + m + minutos;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${pad2(hh)}:${pad2(mm)}`;
}


function toArgentinaDateTime(fecha, hora) {
  return `${fecha}T${hora}:00-03:00`;
}


function extraerJSON(texto) {
  try {
    const limpio = String(texto || '').replace(/```json|```/gi, '').trim();
    const inicio = limpio.indexOf('{');
    const fin = limpio.lastIndexOf('}');


    if (inicio === -1 || fin === -1 || fin < inicio) {
      throw new Error('No se encontró JSON válido');
    }


    return JSON.parse(limpio.substring(inicio, fin + 1));
  } catch (err) {
    console.log('❌ Error parseando JSON');
    console.log('🔍 RESPUESTA ORIGINAL:\n', texto);
    throw err;
  }
}


function validarIntencion(intencion) {
  if (!intencion || typeof intencion !== 'object') {
    throw new Error('La intención no es un objeto válido');
  }


  const tiposValidos = ['agendar', 'hoy', 'dia', 'semana', 'error'];


  if (!tiposValidos.includes(intencion.tipo)) {
    throw new Error(`Tipo inválido: ${intencion.tipo}`);
  }


  if (intencion.tipo === 'agendar') {
    if (!limpiarTexto(intencion.titulo)) {
      throw new Error('Falta título');
    }


    if (!esFechaISO(intencion.fecha)) {
      throw new Error(`Fecha inválida: ${intencion.fecha}`);
    }


    if (intencion.hora && !esHoraHHMM(intencion.hora)) {
      throw new Error(`Hora inválida: ${intencion.hora}`);
    }


    const duracion = intencion.duracionMin === undefined
      ? 60
      : Number(intencion.duracionMin);


    if (!Number.isInteger(duracion) || duracion <= 0 || duracion > 720) {
      throw new Error('Duración inválida');
    }


    intencion.titulo = limpiarTexto(intencion.titulo);
    intencion.descripcion = limpiarTexto(intencion.descripcion || '');
    intencion.hora = intencion.hora ? limpiarTexto(intencion.hora) : null;
    intencion.duracionMin = duracion;
  }


  if (intencion.tipo === 'dia' && !esFechaISO(intencion.fecha)) {
    throw new Error(`Fecha inválida: ${intencion.fecha}`);
  }


  if (intencion.tipo === 'error') {
    intencion.motivo = limpiarTexto(intencion.motivo || 'No entendí la solicitud');
  }


  return intencion;
}


function leerJsonDesdeEnvONombre(envName, filePath) {
  if (process.env[envName]) {
    return JSON.parse(process.env[envName]);
  }


  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }


  throw new Error(`Falta ${envName} o archivo ${filePath}`);
}


async function getCalendarClient() {
  const creds = leerJsonDesdeEnvONombre(
    'GOOGLE_CREDS_JSON',
    process.env.GOOGLE_CREDS_PATH || 'credentials.json'
  );


  const token = leerJsonDesdeEnvONombre(
    'GOOGLE_TOKEN_JSON',
    process.env.GOOGLE_TOKEN_PATH || 'token.json'
  );


  const root = creds.installed || creds.web;


  if (!root?.client_id || !root?.client_secret || !root?.redirect_uris?.[0]) {
    throw new Error('Credenciales Google inválidas');
  }


  const oAuth2 = new google.auth.OAuth2(
    root.client_id,
    root.client_secret,
    root.redirect_uris[0]
  );


  oAuth2.setCredentials(token);


  return google.calendar({ version: 'v3', auth: oAuth2 });
}


async function getEventosPorRango(calendar, inicio, fin) {
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: inicio.toISOString(),
    timeMax: fin.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });


  return res.data.items || [];
}


function formatearEventosHtml(eventos, titulo) {
  if (!eventos.length) {
    return `<b>${escapeHtml(titulo)}</b>\n\nNo tenés eventos agendados 🏔️`;
  }


  let msg = `<b>${escapeHtml(titulo)}</b>\n\n`;


  for (const ev of eventos) {
    const resumen = escapeHtml(ev.summary || 'Sin título');


    if (ev.start?.dateTime) {
      const hora = new Date(ev.start.dateTime).toLocaleTimeString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
      });


      msg += `📌 <b>${escapeHtml(hora)}hs</b> — ${resumen}\n`;
    } else {
      msg += `📌 Todo el día — ${resumen}\n`;
    }
  }


  msg += `\n<b>${eventos.length} evento${eventos.length > 1 ? 's' : ''}</b>`;
  return msg;
}


async function agendaHoy(calendar) {
  const ahora = new Date();
  const inicio = new Date(ahora);
  const fin = new Date(ahora);


  inicio.setHours(0, 0, 0, 0);
  fin.setHours(23, 59, 59, 999);


  const eventos = await getEventosPorRango(calendar, inicio, fin);


  const fechaLabel = ahora.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });


  return formatearEventosHtml(eventos, `Agenda de hoy — ${fechaLabel}`);
}


async function agendaDia(calendar, fechaStr) {
  const fecha = new Date(`${fechaStr}T00:00:00`);
  const inicio = new Date(fecha);
  const fin = new Date(fecha);


  inicio.setHours(0, 0, 0, 0);
  fin.setHours(23, 59, 59, 999);


  const eventos = await getEventosPorRango(calendar, inicio, fin);


  const fechaLabel = fecha.toLocaleDateString('es-AR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });


  return formatearEventosHtml(eventos, `Agenda del ${fechaLabel}`);
}


async function agendaSemana(calendar) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);


  const fin = new Date(hoy);
  fin.setDate(fin.getDate() + 7);
  fin.setHours(23, 59, 59, 999);


  const eventos = await getEventosPorRango(calendar, hoy, fin);


  if (!eventos.length) {
    return '<b>Agenda de los próximos 7 días</b>\n\nNo tenés eventos agendados 🏔️';
  }


  let msg = '<b>Agenda de los próximos 7 días</b>\n\n';
  let diaActual = '';


  for (const ev of eventos) {
    const fechaEv = ev.start?.dateTime
      ? new Date(ev.start.dateTime)
      : new Date(ev.start?.date);


    const diaLabel = fechaEv.toLocaleDateString('es-AR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });


    if (diaLabel !== diaActual) {
      msg += `\n<b>${escapeHtml(diaLabel)}</b>\n`;
      diaActual = diaLabel;
    }


    const resumen = escapeHtml(ev.summary || 'Sin título');


    if (ev.start?.dateTime) {
      const hora = fechaEv.toLocaleTimeString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
      });


      msg += `📌 ${escapeHtml(hora)}hs — ${resumen}\n`;
    } else {
      msg += `📌 Todo el día — ${resumen}\n`;
    }
  }


  msg += `\n<b>${eventos.length} evento${eventos.length > 1 ? 's' : ''} en total</b>`;
  return msg;
}


async function crearEvento(calendar, tarea) {
  if (!tarea.hora) return null;


  const horaFin = sumarMinutos(tarea.hora, tarea.duracionMin || 60);


  const event = {
    summary: tarea.titulo,
    description: tarea.descripcion || '',
    start: {
      dateTime: toArgentinaDateTime(tarea.fecha, tarea.hora),
      timeZone: CALENDAR_TIMEZONE,
    },
    end: {
      dateTime: toArgentinaDateTime(tarea.fecha, horaFin),
      timeZone: CALENDAR_TIMEZONE,
    },
  };


  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
  });


  return {
    ...tarea,
    horaFin,
    calendarId: res.data.id || null,
    calendarLink: res.data.htmlLink || null,
  };
}


async function crearTareaAsana(tarea) {
  if (!ASANA_TOKEN || !ASANA_PROJECT_GID) {
    console.log('Asana no configurado para creación');
    return null;
  }


  const body = {
    data: {
      name: tarea.titulo,
      notes: [
        `Descripción: ${tarea.descripcion || 'Sin detalle'}`,
        `Fecha: ${tarea.fecha}`,
        `Hora: ${tarea.hora || 'Sin hora asignada'}`,
        `Duración: ${tarea.duracionMin || 60} min`,
        'Origen: Bot Telegram',
      ].join('\n'),
      projects: [ASANA_PROJECT_GID],
    },
  };


  const res = await fetch('https://app.asana.com/api/1.0/tasks', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ASANA_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });


  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Error Asana creando tarea: ${res.status} - ${txt}`);
  }


  const json = await res.json();
  return json.data;
}


async function obtenerTareasAsanaNotificables() {
  if (!ASANA_TOKEN || !ASANA_NOTIFY_SECTION_GID) {
    console.log('Asana no configurado para sección de notificación');
    return [];
  }


  const res = await fetch(
    `https://app.asana.com/api/1.0/sections/${ASANA_NOTIFY_SECTION_GID}/tasks?opt_fields=name,completed,due_on&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${ASANA_TOKEN}`,
        Accept: 'application/json',
      },
    }
  );


  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Error leyendo sección de Asana: ${res.status} - ${txt}`);
  }


  const json = await res.json();
  return (json.data || []).filter(t => !t.completed);
}


function formatearTareasAsanaHtml(tareas) {
  if (!tareas.length) {
    return '<b>✅ Tareas a notificar</b>\n\nNo tenés tareas para hoy.';
  }


  let msg = '<b>✅ Tareas a notificar</b>\n\n';


  for (const t of tareas.slice(0, 10)) {
    msg += `• ${escapeHtml(t.name || 'Sin título')}\n`;
  }


  msg += `\n<b>${tareas.length} tarea${tareas.length > 1 ? 's' : ''}</b>`;
  return msg;
}


async function clasificarMensaje(texto) {
  const hoyTexto = new Date().toLocaleDateString('es-AR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });


  const hoyISO = obtenerFechaRelativa(0);
  const mananaISO = obtenerFechaRelativa(1);
  const pasadoISO = obtenerFechaRelativa(2);


  const prompt = `
Hoy es ${hoyTexto} (${hoyISO}).
Mañana es ${mananaISO}.
Pasado mañana es ${pasadoISO}.


El usuario manda: "${texto}".


Tu tarea es clasificar la intención para un asistente de agenda y tareas.


Reglas:
- Si el usuario pide agendar, crear recordatorio, reunión, llamada, turno o tarea con fecha, devolvé tipo "agendar".
- La fecha es obligatoria para agendar.
- La hora es opcional.
- Si el usuario menciona hora, devolvé "hora": "HH:MM".
- Si el usuario NO menciona hora, devolvé "hora": null.
- Si falta fecha, devolvé tipo "error".
- Si no menciona duración, usar 60 minutos.
- Interpretá referencias como hoy, mañana, pasado mañana, este viernes, el lunes, la semana que viene.
- Respondé SOLO JSON válido.
- No agregues texto antes ni después.
- No uses markdown.


Formatos válidos:
{"tipo":"agendar","titulo":"...","fecha":"YYYY-MM-DD","hora":"HH:MM","duracionMin":60,"descripcion":"..."}
{"tipo":"agendar","titulo":"...","fecha":"YYYY-MM-DD","hora":null,"duracionMin":60,"descripcion":"..."}
{"tipo":"hoy"}
{"tipo":"dia","fecha":"YYYY-MM-DD"}
{"tipo":"semana"}
{"tipo":"error","motivo":"..."}
`.trim();


  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  });


  const textoRespuesta = resp.content?.[0]?.text || '';
  const json = extraerJSON(textoRespuesta);
  return validarIntencion(json);
}


async function descargarArchivoTelegram(filePath) {
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const res = await fetch(url);


  if (!res.ok) {
    throw new Error(`No pude descargar el archivo de Telegram: HTTP ${res.status}`);
  }


  return Buffer.from(await res.arrayBuffer());
}


async function transcribirAudioTelegram(fileId) {
  const fileInfo = await bot.getFile(fileId);


  if (!fileInfo?.file_path) {
    throw new Error('Telegram no devolvió file_path para el audio');
  }


  const buffer = await descargarArchivoTelegram(fileInfo.file_path);
  const tmpPath = path.join(os.tmpdir(), `audio_${Date.now()}.ogg`);


  fs.writeFileSync(tmpPath, buffer);


  try {
    const transcripcion = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'es',
    });


    return limpiarTexto(transcripcion.text || '');
  } finally {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }
}


async function enviarHtml(chatId, html) {
  await bot.sendMessage(chatId, html, { parse_mode: 'HTML' });
}


async function enviarResumenDiario() {
  try {
    if (!TELEGRAM_CHAT_ID) {
      console.warn('Falta TELEGRAM_CHAT_ID');
      return;
    }


    const calendar = await getCalendarClient();
    const agenda = await agendaHoy(calendar);


    let bloqueAsana = '<b>✅ Tareas a notificar</b>\n\nNo pude leer Asana.';


    try {
      const tareas = await obtenerTareasAsanaNotificables();
      bloqueAsana = formatearTareasAsanaHtml(tareas);
    } catch (err) {
      console.error('Error Asana resumen:', err.message);
    }


    const mensaje = [
      '<b>🌅 Buenos días Guille</b>',
      '',
      agenda,
      '',
      bloqueAsana,
      '',
      'Buen día 💪',
    ].join('\n');


    await enviarHtml(TELEGRAM_CHAT_ID, mensaje);
  } catch (err) {
    console.error('Error en resumen diario:', err);
  }
}


const [horaCron, minutoCron] = HORA_RESUMEN.split(':');


cron.schedule(
  `${Number(minutoCron)} ${Number(horaCron)} * * *`,
  async () => {
    console.log('Enviando resumen diario...');
    await enviarResumenDiario();
  },
  { timezone: CALENDAR_TIMEZONE }
);


bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let texto = '';


  try {
    if (msg.voice) {
      await bot.sendMessage(chatId, '🎙️ Transcribiendo...');
      texto = await transcribirAudioTelegram(msg.voice.file_id);


      if (!texto) {
        await bot.sendMessage(chatId, 'No pude entender el audio. Probá de nuevo.');
        return;
      }


      await bot.sendMessage(chatId, `📝 Entendí: "${texto}"`);
    } else if (msg.text === '/start') {
      await enviarHtml(
        chatId,
        '<b>Bot de agenda activo ✅</b>\n\nComandos:\n/hoy\n/semana\n/resumen'
      );
      return;
    } else if (msg.text === '/hoy') {
      const calendar = await getCalendarClient();
      const respuesta = await agendaHoy(calendar);
      await enviarHtml(chatId, respuesta);
      return;
    } else if (msg.text === '/semana') {
      const calendar = await getCalendarClient();
      const respuesta = await agendaSemana(calendar);
      await enviarHtml(chatId, respuesta);
      return;
    } else if (msg.text === '/resumen') {
      await enviarResumenDiario();
      await bot.sendMessage(chatId, '✅ Resumen enviado');
      return;
    } else if (msg.text && !msg.text.startsWith('/')) {
      texto = limpiarTexto(msg.text);
    }


    if (!texto) return;


    await bot.sendMessage(chatId, '⚙️ Procesando...');
    const intencion = await clasificarMensaje(texto);


    if (intencion.tipo === 'error') {
      await bot.sendMessage(chatId, `❌ ${intencion.motivo}`);
      return;
    }


    if (intencion.tipo === 'agendar') {
      let evento = null;


      if (intencion.hora) {
        const calendar = await getCalendarClient();
        evento = await crearEvento(calendar, intencion);
      }


      let tareaAsana = null;


      try {
        tareaAsana = await crearTareaAsana(intencion);
      } catch (e) {
        console.error('Error creando tarea en Asana:', e.message);
      }


      const mensaje = `
✅ Registrado


📌 ${intencion.titulo}
📅 ${intencion.fecha}
${intencion.hora ? `🕐 ${intencion.hora}hs` : '🕐 Sin hora asignada'}
${intencion.hora ? `⏱️ ${intencion.duracionMin || 60} min` : ''}
${intencion.descripcion ? `📝 ${intencion.descripcion}` : ''}


${evento ? `📅 Google Calendar: creado correctamente\n${evento.calendarLink || ''}` : '📅 Google Calendar: no se creó porque no tenía hora'}


${tareaAsana ? '🗂️ Tarea creada en Asana' : '⚠️ No se creó en Asana'}
      `.trim();


      await bot.sendMessage(chatId, mensaje);
      return;
    }


    const calendar = await getCalendarClient();


    if (intencion.tipo === 'hoy') {
      const respuesta = await agendaHoy(calendar);
      await enviarHtml(chatId, respuesta);
      return;
    }


    if (intencion.tipo === 'dia') {
      const respuesta = await agendaDia(calendar, intencion.fecha);
      await enviarHtml(chatId, respuesta);
      return;
    }


    if (intencion.tipo === 'semana') {
      const respuesta = await agendaSemana(calendar);
      await enviarHtml(chatId, respuesta);
      return;
    }
  } catch (err) {
    console.error('Error general:', err);
    await bot.sendMessage(chatId, '❌ No pude procesar eso.');
  }
});


console.log('Bot corriendo 🚀');
console.log(`Resumen diario programado para las ${HORA_RESUMEN}`);


