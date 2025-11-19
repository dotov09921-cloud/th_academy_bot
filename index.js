require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const { google } = require('googleapis');

// ===================================================================
// ===  БАЗОВЫЕ ПЕРЕМЕННЫЕ ============================================
// ===================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// ---- ТОЛЬКО ЭТА ПЕРЕМЕННАЯ ----
let GOOGLE_CREDENTIALS = null;

try {
  GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS);
} catch (e) {
  console.error("❌ Ошибка парсинга GOOGLE_CREDENTIALS:", e.message);
}

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ===================================================================
if (!BOT_TOKEN) throw new Error("Не указан BOT_TOKEN");

// Инициализация Telegram
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ===================================================================
// === GOOGLE SHEETS: ИНИЦИАЛИЗАЦИЯ =================================
// ===================================================================

let sheets = null;

if (GOOGLE_CREDENTIALS && SPREADSHEET_ID) {
  try {
    const auth = new google.auth.JWT(
      GOOGLE_CREDENTIALS.client_email,
      null,
      GOOGLE_CREDENTIALS.private_key,
      ["https://www.googleapis.com/auth/spreadsheets"]
    );

    sheets = google.sheets({ version: "v4", auth });

    console.log("✅ Google Sheets подключен");
  } catch (err) {
    console.error("❌ Ошибка инициализации Google Sheets:", err.message);
  }
} else {
  console.warn("⚠ GOOGLE_CREDENTIALS или SPREADSHEET_ID отсутствует!");
}

// ===================================================================
// === ФУНКЦИИ ЛОГГИРОВАНИЯ ==========================================
// ===================================================================

// USERS: user_id | name | username | created_at
async function logRegistrationToSheets(userId, name, username) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "USERS!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[String(userId), name, username || "", new Date().toISOString()]],
      },
    });
  } catch (e) {
    console.error("Ошибка записи USERS:", e.message);
  }
}

// PROGRESS
async function logProgressToSheets(userId, u, result) {
  if (!sheets) return;

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "PROGRESS!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          String(userId),
          u.name,
          u.currentLesson,
          result,
          u.points,
          new Date().toISOString(),
          u.nextLessonAt ? new Date(u.nextLessonAt).toISOString() : ""
        ]]
      },
    });
  } catch (e) {
    console.error("Ошибка записи PROGRESS:", e.message);
  }
}

// ===================================================================
// === DB (храним прогресс) ===========================================
// ===================================================================

async function loadUserFromDB(userId) {
  if (!sheets) return null;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "DB!A2:G9999",
    });

    const rows = res.data.values || [];
    const row = rows.find(r => r[0] === String(userId));

    if (!row) return null;

    return {
      name: row[1],
      currentLesson: Number(row[2]),
      points: Number(row[3]),
      nextLessonAt: Number(row[4]),
      lastLessonAt: Number(row[5]),
      waitingAnswer: row[6] === "true",
    };
  } catch (e) {
    console.error("Ошибка DB load:", e.message);
    return null;
  }
}

async function saveUserToDB(userId) {
  if (!sheets || !users[userId]) return;

  const u = users[userId];

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "DB!A2:A9999",
    });

    const rows = res.data.values || [];
    const index = rows.findIndex(r => r[0] === String(userId));

    const values = [
      String(userId),
      u.name,
      u.currentLesson,
      u.points,
      u.nextLessonAt,
      u.lastLessonAt,
      u.waitingAnswer ? "true" : "false",
    ];

    if (index === -1) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: "DB!A:G",
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [values] },
      });
    } else {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `DB!A${index + 2}:G${index + 2}`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [values] },
      });
    }
  } catch (e) {
    console.error("Ошибка DB save:", e.message);
  }
}

// ===================================================================
// === ЛОГИКА ОБУЧЕНИЯ =================================================
// ===================================================================

const tempUsers = {};
const users = {};

const lessons = {
  1: { text: 'Урок 1: Что такое ЛКМ?\nОтвет: "лак"', answer: "лак" },
  2: { text: 'Урок 2: Что такое грунт?\nОтвет: "грунт"', answer: "грунт" },
};

// /start
bot.start(async ctx => {
  const id = ctx.from.id;

  const saved = await loadUserFromDB(id);
  if (saved) {
    users[id] = saved;
    return ctx.reply(`С возвращением, ${saved.name}!`);
  }

  tempUsers[id] = { step: "ask_name" };
  return ctx.reply("Привет! Напиши своё имя:");
});

// обработка текстов
bot.on("text", async ctx => {
  const id = ctx.from.id;
  const text = ctx.message.text.trim();

  if (tempUsers[id]?.step === "ask_name") {
    users[id] = {
      name: text,
      currentLesson: 1,
      points: 0,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
    };

    await logRegistrationToSheets(id, text, ctx.from.username);
    await saveUserToDB(id);

    delete tempUsers[id];

    return sendLesson(ctx, 1);
  }

  if (!users[id] || !users[id].waitingAnswer) return;

  const u = users[id];
  const lesson = lessons[u.currentLesson];

  if (text.toLowerCase() === lesson.answer.toLowerCase()) {
    u.points++;
    u.waitingAnswer = false;
    u.currentLesson++;
    u.nextLessonAt = Date.now() + 24 * 3600 * 1000;

    await ctx.reply("✅ Верно! Следующий урок через 24 часа.");
    await logProgressToSheets(id, u, "OK");
    return saveUserToDB(id);
  }

  u.waitingAnswer = false;
  u.nextLessonAt = Date.now() + 30 * 60 * 1000;

  await ctx.reply("❌ Неправильно. Повтор через 30 минут.");
  await logProgressToSheets(id, u, "FAIL");
  return saveUserToDB(id);
});

async function sendLesson(ctx, num) {
  const id = ctx.from.id;

  users[id].waitingAnswer = true;
  users[id].lastLessonAt = Date.now();

  await ctx.reply(`Урок ${num}\n\n${lessons[num].text}\n\nНапиши ответ:`);

  return saveUserToDB(id);
}

// ===================================================================
// === WEBHOOK ========================================================
// ===================================================================

if (WEBHOOK_URL) {
  bot.telegram.setWebhook(WEBHOOK_URL);
  app.use(bot.webhookCallback("/telegram-webhook"));

  app.listen(PORT, () => console.log("Server started:", PORT));
} else {
  bot.launch();
}

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
