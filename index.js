require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');
const admin = require('firebase-admin');

// ===================================================================
// ===  FIREBASE ИНИЦИАЛИЗАЦИЯ =======================================
// ===================================================================

let firebaseConfig = process.env.FIREBASE_CREDENTIALS;

if (!firebaseConfig) {
  throw new Error("Нет FIREBASE_CREDENTIALS в переменных окружения");
}

try {
  firebaseConfig = JSON.parse(firebaseConfig);
} catch (e) {
  console.error("❌ Ошибка парсинга FIREBASE_CREDENTIALS:", e.message);
}

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

const db = admin.firestore();
console.log("🔥 Firestore подключен");

// ===================================================================
// ===  БАЗОВЫЕ ПЕРЕМЕННЫЕ ===========================================
// ===================================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Нет BOT_TOKEN в Environment");

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ===================================================================
// ===  FIRESTORE ФУНКЦИИ ============================================
// ===================================================================

async function loadUser(userId) {
  const doc = await db.collection("users").doc(String(userId)).get();
  return doc.exists ? doc.data() : null;
}

async function saveUser(userId, data) {
  await db.collection("users").doc(String(userId)).set(data, { merge: true });
}

async function logProgress(userId, userState, result) {
  await db.collection("progress").add({
    userId,
    name: userState.name,
    lesson: userState.currentLesson,
    result,
    points: userState.points,
    timestamp: Date.now(),
  });
}

// ===================================================================
// ===  ВРЕМЕННЫЕ ХРАНИЛИЩА ==========================================
// ===================================================================

const tempUsers = {};
const users = {};

// ===================================================================
// ===  УРОКИ =========================================================
// ===================================================================

const lessons = {
  1: { text: "Урок 1: Что такое ЛКМ? Напиши ответ: ЛАК", answer: "лак" },
  2: { text: "Урок 2: Что такое грунт? Напиши: ГРУНТ", answer: "грунт" },
};

// ===================================================================
// ===  /start ========================================================
// ===================================================================

bot.start(async (ctx) => {
  const userId = ctx.from.id;

  const saved = await loadUser(userId);

  if (saved) {
    users[userId] = saved;
    return ctx.reply(`С возвращением, ${saved.name}! Продолжаем 📚`);
  }

  tempUsers[userId] = { step: "ask_name" };
  ctx.reply("Привет! Напиши своё имя для регистрации:");
});

// ===================================================================
// ===  ОБРАБОТКА СООБЩЕНИЙ ===========================================
// ===================================================================

bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim().toLowerCase();

  // Регистрация
  if (tempUsers[userId]?.step === "ask_name") {
    const name = ctx.message.text.trim();

    const userState = {
      name,
      currentLesson: 1,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
      points: 0,
    };

    users[userId] = userState;
    await saveUser(userId, userState);

    delete tempUsers[userId];

    await ctx.reply(`Отлично, ${name}! Начинаем обучение.`);
    return sendLesson(ctx, 1);
  }

  // Если не зарегистрирован
  if (!users[userId]) return;

  const u = users[userId];

  if (!u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  if (!lesson) return ctx.reply("Уроки закончились 🎉");

  if (text === lesson.answer.toLowerCase()) {
    u.points++;
    u.waitingAnswer = false;
    u.currentLesson++;
    u.nextLessonAt = Date.now() + 24 * 3600 * 1000;

    await ctx.reply("✅ Правильно! Следующий урок через 24 часа.");
    await logProgress(userId, u, "OK");
    await saveUser(userId, u);

  } else {
    u.waitingAnswer = false;
    u.nextLessonAt = Date.now() + 30 * 60 * 1000;

    await ctx.reply("❌ Ошибка. Повтор урока через 30 минут.");
    await logProgress(userId, u, "FAIL");
    await saveUser(userId, u);
  }
});

// ===================================================================
// === ОТПРАВКА УРОКА =================================================
// ===================================================================

async function sendLesson(ctx, lessonNumber) {
  const userId = ctx.from.id;
  const lesson = lessons[lessonNumber];

  users[userId].waitingAnswer = true;
  users[userId].lastLessonAt = Date.now();

  await ctx.reply(`Урок ${lessonNumber}\n\n${lesson.text}`);

  await saveUser(userId, users[userId]);
}

// ===================================================================
// === WEBHOOK ========================================================
// ===================================================================

if (WEBHOOK_URL) {
  const path = "/telegram-webhook";

  bot.telegram.setWebhook(WEBHOOK_URL);
  app.use(bot.webhookCallback(path));

  app.get("/", (_, res) => res.send("Bot is running"));

  app.listen(PORT, () => console.log("Server started:", PORT));

} else {
  console.log("➡ Запуск в режиме polling");
  bot.launch();
}

bot.command('итоги', async (ctx) => {
  try {
    const usersSnap = await db.collection('users').get();

    if (usersSnap.empty) {
      return ctx.reply("Пользователи не найдены.");
    }

    let result = "🏆 Итоги обучения за 90 дней:\n\n";

    const users = [];

    usersSnap.forEach(doc => {
      const data = doc.data();
      users.push({
        name: data.name,
        points: data.points || 0
      });
    });

    // сортировка по количеству баллов (от большего к меньшему)
    users.sort((a, b) => b.points - a.points);

    users.forEach((u, i) => {
      result += `${i + 1}. ${u.name} — ${u.points} баллов\n`;
    });

    ctx.reply(result);

  } catch (err) {
    console.error("Ошибка получения итогов:", err.message);
    ctx.reply("Произошла ошибка при загрузке итогов.");
  }
});


// Корректное завершение
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
