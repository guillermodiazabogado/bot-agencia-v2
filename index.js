require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const TOKEN_PATH = 'token.json';
const CREDS_PATH = 'credentials.json';

async function getCalendarClient() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH));
  const { client_secret, client_id, redirect_uris } = creds.installed;
  const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH)));
  } else {
    const url = oAuth2.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
    console.log('Autorizá Google Calendar abriendo esta URL:\n', url);
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise((res) => rl.question('\nPegá el código de autorización: ', (code) => {
      rl.close();
      oAuth2.getToken(code, (err, token) => {
        if (err) return console.error(err);
        oAuth2.setCredentials(token);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
        res();
      });
    }));
  }
  return google.calendar({ version: 'v3', auth: oAuth2 });
}

function extraerJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  const match = limpio.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No se encontró JSON en la respuesta');
  return JSON.parse(match[0]);
}

async function parseTarea(texto) {
  const hoy = new Date().toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
  const resp = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Hoy es ${hoy}. El usuario dice: "${texto}".
Extraé la tarea, fecha y hora.
Respondé ÚNICAMENTE con este JSON, sin texto antes ni después, sin comillas triples:
{"titulo":"...","fecha":"YYYY-MM-DD","hora":"HH:MM","descripcion":"..."}`
    }]
  });
  return extraerJSON(resp.content[0].text);
}

async function crearEvento(calendar, tarea) {
  const start = new Date(`${tarea.fecha}T${tarea.hora}:00`);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const event = {
    summary: tarea.titulo,
    description: tarea.descripcion,
    start: { dateTime: start.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
    end: { dateTime: end.toISOString(), timeZone: 'America/Argentina/Buenos_Aires' },
  };
  await calendar.events.insert({ calendarId: 'primary', resource: event });
  return { titulo: tarea.titulo, fecha: tarea.fecha, hora: tarea.hora };
}

async function getEventosHoy(calendar) {
  const ahora = new Date();
  const inicio = new Date(ahora);
  inicio.setHours(0, 0, 0, 0);
  const fin = new Date(ahora);
  fin.setHours(23, 59, 59, 999);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: inicio.toISOString(),
    timeMax: fin.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return res.data.items || [];
}

async function enviarResumenDiario() {
  try {
    const calendar = await getCalendarClient();
    const eventos = await getEventosHoy(calendar);
    const fechaHoy = new Date().toLocaleDateString('es-AR', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
    let mensaje = `🌅 *Buenos días Guille*\n\n📆 *${fechaHoy}*\n\n`;
    if (eventos.length === 0) {
      mensaje += `No tenés eventos agendados para hoy.\n\nDía libre 🏔️`;
    } else {
      eventos.forEach(ev => {
        const hora = ev.start.dateTime
          ? new Date(ev.start.dateTime).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })
          : 'Todo el día';
        mensaje += `📌 *${hora}hs* — ${ev.summary}\n`;
      });
      mensaje += `\n*${eventos.length} evento${eventos.length > 1 ? 's' : ''} hoy. Buen día 💪*`;
    }
    await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, mensaje, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error en resumen diario:', err);
  }
}

const [hora, minuto] = (process.env.HORA_RESUMEN || '07:30').split(':');
cron.schedule(`${minuto} ${hora} * * *`, () => {
  console.log('Enviando resumen diario...');
  enviarResumenDiario();
}, {
  timezone: 'America/Argentina/Buenos_Aires'
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  let texto = '';
  try {
    if (msg.voice) {
      await bot.sendMessage(chatId, '🎙️ Transcribiendo audio...');
      const fileInfo = await bot.getFile(msg.voice.file_id);
      const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${fileInfo.file_path}`;
      const res = await fetch(url);
      const buffer = Buffer.from(await res.arrayBuffer());
      const tmpPath = path.join('C:/Windows/Temp', `audio_${Date.now()}.ogg`);
      fs.writeFileSync(tmpPath, buffer);
      const transcripcion = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'whisper-1',
        language: 'es',
      });
      fs.unlinkSync(tmpPath);
      texto = transcripcion.text;
      await bot.sendMessage(chatId, `📝 Entendí: "${texto}"`);
    } else if (msg.text === '/resumen') {
      await enviarResumenDiario();
      return;
    } else if (msg.text && !msg.text.startsWith('/')) {
      texto = msg.text;
    }

    if (!texto) return;

    await bot.sendMessage(chatId, '⚙️ Procesando...');
    const tarea = await parseTarea(texto);
    const calendar = await getCalendarClient();
    const evento = await crearEvento(calendar, tarea);

    await bot.sendMessage(chatId,
      `✅ *Agendado*\n\n📌 ${evento.titulo}\n📅 ${evento.fecha}\n🕐 ${evento.hora}hs`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error:', err.message);
    await bot.sendMessage(chatId, '❌ No pude procesar eso. Intentá ser más específico con la fecha y hora.');
  }
});

console.log('Bot iniciado ✅');
console.log(`Resumen diario programado para las ${process.env.HORA_RESUMEN}hs`);
console.log('Escuchando mensajes...');
