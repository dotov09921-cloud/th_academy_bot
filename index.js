require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const { google } = require('googleapis');

// ===================================================================
// ===  БАЗОВЫЕ ПЕРЕМЕННЫЕ  ==========================================
// ===================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// JSON сервисного аккаунта — берём из GOOGLE_CREDENTIALS или GOOGLE_SERVICE_ACCOUNT
const rawGoogleCreds =
  process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT || null;

let GOOGLE_CREDENTIALS = null;
if (rawGoogleCreds) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(rawGoogleCreds);
  } catch (e) {
    console.error('❌ Ошибка парсинга GOOGLE_CREDENTIALS:', e.message);
  }
}

// ID Google таблицы
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!BOT_TOKEN) throw new Error('Не указан BOT_TOKEN в переменных окружения');

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ===================================================================
// ===  GOOGLE SHEETS: ИНИЦИАЛИЗАЦИЯ  ================================
// ===================================================================

let sheets = null;

if (GOOGLE_CREDENTIALS && SPREADSHEET_ID) {
  try {
    const auth = new google.auth.JWT(
      GOOGLE_CREDENTIALS.client_email,
      null,
      GOOGLE_CREDENTIALS.private_key,
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    sheets = google.sheets({ version: 'v4', auth });
    console.log('✅ Google Sheets подключен');
  } catch (err) {
    console.error('❌ Ошибка инициализации Google Sheets:', err.message);
  }
} else {
  console.warn('⚠ Нет GOOGLE_CREDENTIALS или SPREADSHEET_ID — логирование отключено');
}

// -------------------------------------------------------------------
// === ЛОГИ В GOOGLE SHEETS ==========================================
// -------------------------------------------------------------------

// USERS: user_id | name | username | created_at
async function logRegistrationToSheets(userId, name, username) {
  if (!sheets) return;
  const now = new Date().toISOString();

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'USERS!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[String(userId), name, username || '', now]],
      },
    });
    console.log(`📝 USERS добавлен → ${userId} | ${name}`);
  } catch (err) {
    console.error('Ошибка записи USERS:', err.message);
  }
}

// PROGRESS: user_id | name | lesson | result | points | last_at | next_at
async function logProgressToSheets(userId, userState, result) {
  if (!sheets) return;

  const now = new Date().toISOString();
  const nextAt = userState.nextLessonAt
    ? new Date(userState.nextLessonAt).toISOString()
    : '';

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'PROGRESS!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          String(userId),
          userState.name,
          userState.currentLesson,
          result,
          userState.points,
          now,
          nextAt,
        ]],
      },
    });
    console.log(`📝 PROGRESS → ${userId} | lesson ${userState.currentLesson} | ${result}`);
  } catch (err) {
    console.error('Ошибка записи PROGRESS:', err.message);
  }
}

// -------------------------------------------------------------------
// === БАЗА ДАННЫХ В ЛИСТЕ DB ========================================
// -------------------------------------------------------------------

async function loadUserFromDB(userId) {
  if (!sheets) return null;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB!A2:G9999',
    });

    const rows = res.data.values || [];
    const row = rows.find(r => r[0] === String(userId));
    if (!row) return null;

    return {
      name: row[1],
      currentLesson: Number(row[2]) || 1,
      points: Number(row[3]) || 0,
      nextLessonAt: Number(row[4]) || 0,
      lastLessonAt: Number(row[5]) || 0,
      waitingAnswer: row[6] === 'true',
    };
  } catch (err) {
    console.error('Ошибка DB load:', err.message);
    return null;
  }
}

async function saveUserToDB(userId) {
  if (!sheets || !users[userId]) return;

  const u = users[userId];

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB!A2:A9999',
    });

    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => r[0] === String(userId));

    const values = [
      String(userId),
      u.name,
      String(u.currentLesson),
      String(u.points),
      String(u.nextLessonAt),
      String(u.lastLessonAt),
      u.waitingAnswer ? 'true' : 'false',
    ];

    if (rowIndex === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB!A:G',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
      });
    } else {
      const range = `DB!A${rowIndex + 2}:G${rowIndex + 2}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
      });
    }

    console.log(`💾 DB сохранён: ${userId}`);
  } catch (err) {
    console.error('Ошибка DB save:', err.message);
  }
}

// ===================================================================
// === ЛОГИКА ОБУЧЕНИЯ ===============================================
// ===================================================================

const tempUsers = {};
const users = {};

const lessons = {
  1: { text: 'Урок 1: Что такое ЛКМ?\n\nОтвет: "лак"', answer: 'лак' },
  2: { text: 'Урок 2: Что такое грунт?\n\nОтвет: "грунт"', answer: 'грунт' },
};

// /start
bot.start(async ctx => {
  const userId = ctx.from.id;

  const saved = await loadUserFromDB(userId);
  if (saved) {
    users[userId] = saved;
    await ctx.reply(`С возвращением, ${saved.name}!`);
    return;
  }

  tempUsers[userId] = { step: 'ask_name' };
  await ctx.reply('Привет! Напиши своё имя:');
});

// ОТВЕТЫ
bot.on('text', async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // регистрация
  if (tempUsers[userId]?.step === 'ask_name') {
    users[userId] = {
      name: text,
      currentLesson: 1,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
      points: 0,
    };

    await logRegistrationToSheets(userId, text, ctx.from.username);
    await saveUserToDB(userId);

    delete tempUsers[userId];

    await ctx.reply(`Отлично, ${text}! Начинаем обучение.`);
    return sendLesson(ctx, 1);
  }

  if (!users[userId]) return;
  const u = users[userId];

  if (!u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  if (!lesson) return ctx.reply('Все уроки завершены 🎉');

  const correct = lesson.answer.toLowerCase();
  const userAnswer = text.toLowerCase();

  if (correct === userAnswer) {
    u.points++;
    u.waitingAnswer = false;
    u.currentLesson++;
    u.nextLessonAt = Date.now() + 24 * 3600 * 1000;

    await ctx.reply('✅ Правильно! Следующий урок через 24 часа.');
    await logProgressToSheets(userId, u, 'OK');
    return saveUserToDB(userId);
  } else {
    u.waitingAnswer = false;
    u.nextLessonAt = Date.now() + 30 * 60 * 1000;

    await ctx.reply('❌ Неправильно. Повтор урока через 30 минут.');
    await logProgressToSheets(userId, u, 'FAIL');
    return saveUserToDB(userId);
  }
});

// отправка урока
async function sendLesson(ctx, num) {
  const userId = ctx.from.id;
  const lesson = lessons[num];

  if (!lesson) return ctx.reply('Уроки закончились.');

  users[userId].waitingAnswer = true;
  users[userId].lastLessonAt = Date.now();

  await ctx.reply(`Урок ${num}\n\n${lesson.text}\n\nНапиши ответ:`);
  await saveUserToDB(userId);
}

// тест команда
bot.hears('тест', ctx => ctx.reply('Бот работает 💪'));

// ===================================================================
// === WEBHOOK ========================================================
// ===================================================================

if (WEBHOOK_URL) {
  const path = '/telegram-webhook';

  bot.telegram.setWebhook(WEBHOOK_URL);
  app.use(bot.webhookCallback(path));

  app.get('/', (req, res) => res.send('Bot is running'));

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
  });
} else {
  bot.launch();
  console.log('WEBHOOK_URL нет — запускаем polling');
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
