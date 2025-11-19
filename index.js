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

// JSON сервисного аккаунта:
// можно хранить либо в GOOGLE_CREDENTIALS, либо в GOOGLE_SERVICE_ACCOUNT
const rawGoogleCreds =
  process.env.GOOGLE_CREDENTIALS || process.env.GOOGLE_SERVICE_ACCOUNT || null;

let GOOGLE_CREDENTIALS = null;
if (rawGoogleCreds) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(rawGoogleCreds);
  } catch (e) {
    console.error('❌ Не удалось распарсить GOOGLE_* как JSON:', e.message);
  }
}

// ID таблицы с листами USERS / DB / PROGRESS
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!BOT_TOKEN) {
  throw new Error('Не указан BOT_TOKEN в переменных окружения');
}

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
    console.log('✅ Google Sheets инициализирован');
  } catch (err) {
    console.error('❌ Ошибка инициализации Google Sheets:', err.message);
  }
} else {
  console.warn(
    '⚠ GOOGLE_CREDENTIALS/GOOGLE_SERVICE_ACCOUNT или SPREADSHEET_ID не заданы — работа с таблицами отключена'
  );
}

// -------------------------------------------------------------------
// === ФУНКЦИИ ДЛЯ ЛОГА В GOOGLE SHEETS ===============================
// -------------------------------------------------------------------

// USERS!A:D → user_id | name | username | created_at
async function logRegistrationToSheets(userId, name, username) {
  if (!sheets || !SPREADSHEET_ID) return;

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
    console.log(`📝 USERS: добавлен ${userId} | ${name}`);
  } catch (err) {
    console.error('Ошибка записи в USERS:', err.message, err.errors || '');
  }
}

// PROGRESS!A:G → user_id | name | lesson | result | points | last_at | next_at
async function logProgressToSheets(userId, userState, result) {
  if (!sheets || !SPREADSHEET_ID) return;

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
          result, // 'OK' или 'FAIL'
          userState.points,
          now,
          nextAt,
        ]],
      },
    });
    console.log(
      `📝 PROGRESS: ${userId} | lesson=${userState.currentLesson} | ${result}`
    );
  } catch (err) {
    console.error('Ошибка записи в PROGRESS:', err.message);
  }
}

// ===================================================================
// ===  БАЗА ДАННЫХ (лист DB)  =======================================
// ===================================================================
// Заголовки в DB: user_id | name | currentLesson | points | nextLessonAt | lastLessonAt | waitingAnswer

async function loadUserFromDB(userId) {
  if (!sheets || !SPREADSHEET_ID) return null;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB!A2:G9999',
    });

    const rows = res.data.values || [];
    const userRow = rows.find((r) => r[0] === String(userId));

    if (!userRow) return null;

    return {
      name: userRow[1],
      currentLesson: Number(userRow[2]) || 1,
      points: Number(userRow[3]) || 0,
      nextLessonAt: Number(userRow[4]) || 0,
      lastLessonAt: Number(userRow[5]) || 0,
      waitingAnswer: userRow[6] === 'true',
    };
  } catch (err) {
    console.error('Ошибка загрузки из DB:', err.message);
    return null;
  }
}

async function saveUserToDB(userId) {
  if (!sheets || !SPREADSHEET_ID) return;
  if (!users[userId]) return;

  const u = users[userId];

  try {
    // получаем только user_id из DB
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DB!A2:A9999',
    });

    const rows = res.data.values || [];
    const rowIndex = rows.findIndex((r) => r[0] === String(userId));

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
      // новая строка
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'DB!A:G',
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
      });
    } else {
      // обновление существующей строки
      const targetRange = `DB!A${rowIndex + 2}:G${rowIndex + 2}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: targetRange,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [values] },
      });
    }

    console.log(`💾 DB сохранён: user ${userId}`);
  } catch (err) {
    console.error('Ошибка сохранения DB:', err.message);
  }
}

// ===================================================================
// ===  ЛОГИКА ОБУЧЕНИЯ  =============================================
// ===================================================================

// Временное хранилище для регистрации
const tempUsers = {};

// Основное хранилище прогресса в памяти
const users = {};

// Уроки (позже сюда закинем 90 уроков)
const lessons = {
  1: {
    text: 'Урок 1: Что такое ЛКМ?\n\nНапиши одно слово: "лак"',
    answer: 'лак',
  },
  2: {
    text: 'Урок 2: Что такое грунт?\n\nНапиши одно слово: "грунт"',
    answer: 'грунт',
  },
};

// ===== /start → проверка в DB + регистрация ========================
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // 1) пробуем загрузить из DB
  const saved = await loadUserFromDB(userId);

  if (saved) {
    users[userId] = saved;
    await ctx.reply(`С возвращением, ${saved.name}! Продолжаем обучение.`);
    return;
  }

  // 2) если в DB нет — запускаем регистрацию
  tempUsers[userId] = { step: 'ask_name' };
  await ctx.reply('Привет! Введи своё имя для регистрации:');
});

// ===================================================================
// ===  РЕГИСТРАЦИЯ + ПРОГРЕСС + ОТВЕТЫ НА УРОКИ =====================
// ===================================================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const msgRaw = ctx.message.text || '';
  const msg = msgRaw.trim();

  // 1) Регистрация
  if (tempUsers[userId]?.step === 'ask_name') {
    const name = msg;
    const username = ctx.from.username || '';

    console.log(`Регистрация → ${userId} | Имя: ${name}`);

    users[userId] = {
      name,
      currentLesson: 1,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
      points: 0,
    };

    await logRegistrationToSheets(userId, name, username);
    await saveUserToDB(userId);

    delete tempUsers[userId];

    await ctx.reply(`Отлично, ${name}! Регистрация завершена ✅`);
    await sendLesson(ctx, 1);
    return;
  }

  // 2) Если пользователь НЕ зарегистрирован — игнорим
  if (!users[userId]) {
    return;
  }

  // 3) Если бот сейчас НЕ ждёт ответа — игнорим (антиспам)
  if (!users[userId].waitingAnswer) {
    return;
  }

  // 4) Обработка ответа на урок
  const userState = users[userId];
  const currentLesson = userState.currentLesson;
  const lesson = lessons[currentLesson];

  if (!lesson) {
    await ctx.reply('Все доступные уроки уже пройдены 🎉');
    userState.waitingAnswer = false;
    await saveUserToDB(userId);
    return;
  }

  const answerUser = msg.toLowerCase();
  const answerCorrect = lesson.answer.toLowerCase();

  // ===== Правильный ответ ===========================================
  if (answerUser === answerCorrect) {
    userState.waitingAnswer = false;
    userState.points += 1;

    await ctx.reply(
      '✅ Правильно! Балл начислён. Следующий урок придёт через 24 часа.'
    );

    userState.nextLessonAt = Date.now() + 24 * 60 * 60 * 1000; // 24 часа
    userState.currentLesson += 1;

    console.log(
      `USER ${userId} (${userState.name}) | lesson ${currentLesson} OK | points=${userState.points}`
    );

    await logProgressToSheets(userId, userState, 'OK');
    await saveUserToDB(userId);
    return;
  }

  // ===== Неправильный ответ =========================================
  userState.waitingAnswer = false;
  userState.nextLessonAt = Date.now() + 30 * 60 * 1000; // 30 минут

  await ctx.reply('❌ Неправильно. Тот же урок придёт снова через 30 минут.');

  console.log(
    `USER ${userId} (${userState.name}) | lesson ${currentLesson} FAIL | points=${userState.points}`
  );

  await logProgressToSheets(userId, userState, 'FAIL');
  await saveUserToDB(userId);
});

// -------------------------------------------------------------------
// === ФУНКЦИЯ ОТПРАВКИ УРОКА ========================================
// -------------------------------------------------------------------
async function sendLesson(ctx, lessonNumber) {
  const userId = ctx.from.id;

  if (!users[userId]) return;

  const lesson = lessons[lessonNumber];

  if (!lesson) {
    await ctx.reply('🎉 Уроки закончились. Скоро добавим новые.');
    return;
  }

  users[userId].waitingAnswer = true;
  users[userId].lastLessonAt = Date.now();
  users[userId].nextLessonAt = 0; // выставится после ответа

  await ctx.reply(`Урок №${lessonNumber}\n\n${lesson.text}\n\nНапиши ответ:`);

  console.log(
    `SEND LESSON ${lessonNumber} → user ${userId} (${users[userId].name})`
  );

  await saveUserToDB(userId);
}

// ===================================================================
// ===== Доп. команда для теста ======================================
// ===================================================================
bot.hears('тест', (ctx) => ctx.reply('Бот работает 💪'));

// ===================================================================
// ======================   WEBHOOK   ================================
// ===================================================================

if (WEBHOOK_URL) {
  const path = '/telegram-webhook';

  bot.telegram.setWebhook(WEBHOOK_URL);
  app.use(bot.webhookCallback(path));

  app.get('/', (req, res) => res.send('Bot is running'));

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`Webhook path: ${WEBHOOK_URL}`);
  });
} else {
  console.log('WEBHOOK_URL отсутствует → запускаю long polling');
  bot.launch();
}

// ===== Корректное завершение =======================================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
