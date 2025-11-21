require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const admin = require('firebase-admin');
const lessons = require('./lessons');

// ======================================================
// FIREBASE
// ======================================================

let firebaseConfig = process.env.FIREBASE_CREDENTIALS;

if (!firebaseConfig) throw new Error("Нет FIREBASE_CREDENTIALS");

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

// ======================================================
// БОТ НАСТРОЙКИ
// ======================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) throw new Error("Нет BOT_TOKEN");

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ======================================================
// ВРЕМЕННЫЕ ХРАНИЛИЩА
// ======================================================

const tempUsers = {};
const usersCache = {};

// ======================================================
// FIRESTORE ФУНКЦИИ
// ======================================================

async function loadUser(userId) {
  const doc = await db.collection("users").doc(String(userId)).get();
  return doc.exists ? doc.data() : null;
}

async function saveUser(userId, data) {
  await db.collection("users").doc(String(userId)).set(data, { merge: true });
  usersCache[userId] = data;
}

async function logProgress(userId, state, result) {
  await db.collection("progress").add({
    userId,
    name: state.name,
    lesson: state.currentLesson,
    result,
    points: state.points,
    ts: Date.now(),
  });
}

// ======================================================
// ОТПРАВКА УРОКА
// ======================================================

async function sendLesson(userId, lessonNumber) {
  const chatId = Number(userId);
  const lesson = lessons[lessonNumber];

  if (!lesson) {
    await bot.telegram.sendMessage(chatId, "🎉 Все 90 уроков пройдены! Молодец!");

    const u = usersCache[userId];
    u.finished = true;
    u.waitingAnswer = false;
    u.nextLessonAt = null;

    await saveUser(userId, u);
    return;
  }

  const keyboard = Markup.inlineKeyboard(
    lesson.buttons.map(b => [Markup.button.callback(b[0], b[0])])
  );

  await bot.telegram.sendMessage(
    chatId,
    `📘 Урок ${lessonNumber}\n\n${lesson.text}\n\n${lesson.question}`,
    keyboard
  );

  const u = usersCache[userId];
  u.waitingAnswer = true;
  u.lastLessonAt = Date.now();
  u.nextLessonAt = 0;

  await saveUser(userId, u);
}

// ======================================================
// /start
// ======================================================

bot.start(async ctx => {
  const userId = ctx.from.id;

  const saved = await loadUser(userId);

  if (saved) {
    usersCache[userId] = saved;
    return ctx.reply(`С возвращением, ${saved.name}! Продолжаем обучение 📚`);
  }

  tempUsers[userId] = { step: "name" };
  ctx.reply("Привет! Напиши своё имя:");
});

// ======================================================
// ОБРАБОТКА ТЕКСТОВЫХ СООБЩЕНИЙ
// ======================================================

bot.on("text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // регистрация — имя
  if (tempUsers[userId]?.step === "name") {
    const userState = {
      name: text,
      currentLesson: 1,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
      points: 0,
    };

    usersCache[userId] = userState;
    await saveUser(userId, userState);

    tempUsers[userId] = { step: "role" };

    return ctx.reply(
      "Отлично! Теперь выбери свой статус:",
      Markup.inlineKeyboard([
        [Markup.button.callback("👨‍🔧 Сотрудник", "role_employee")],
        [Markup.button.callback("🧑 Клиент", "role_client")],
      ])
    );
  }
});

// ======================================================
// ВЫБОР РОЛИ
// ======================================================

bot.action("role_employee", async ctx => {
  const userId = ctx.from.id;
  const u = usersCache[userId];

  u.role = "сотрудник";   // <-- русский вариант
  await saveUser(userId, u);

  await ctx.reply("Статус сохранён: 👨‍🔧 Сотрудник");
  return sendLesson(userId, u.currentLesson);
});

bot.action("role_client", async ctx => {
  const userId = ctx.from.id;
  const u = usersCache[userId];

  u.role = "клиент";       // <-- русский вариант
  await saveUser(userId, u);

  await ctx.reply("Статус сохранён: 🧑 Клиент");
  return sendLesson(userId, u.currentLesson);
});

// ======================================================
// ОБРАБОТКА ОТВЕТОВ НА КНОПКИ
// ======================================================

// ======================================================
// ОБРАБОТКА ОТВЕТОВ НА КНОПКИ
// ======================================================

bot.on("callback_query", async ctx => {
  const userId = ctx.from.id;
  const answer = ctx.callbackQuery.data;

  const u = usersCache[userId];

  // игнорируем выбор роли (они уже обработаны в bot.action)
  if (answer.startsWith("role_")) return;

  if (!u || !u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  u.waitingAnswer = false;

  // ============================
  //     ПРАВИЛЬНЫЙ ОТВЕТ
  // ============================
  if (answer === lesson.correct) {

    // streak — серия правильных подряд
    u.streak = (u.streak || 0) + 1;

    // стандартный балл
    u.points += 1;

    // бонус за 3 подряд
    if (u.streak === 3) {
      u.points += 1;
      u.streak = 0; // → обнуляем, чтобы снова можно было получить бонус
      await ctx.reply("🔥 Отлично! 3 правильных подряд — бонус +1 балл!");
    }

    u.currentLesson += 1;
    u.nextLessonAt = Date.now() + 24 * 60 * 60 * 1000; // 24 часа

    await ctx.reply("✅ Правильно! Следующий урок — через 24 часа.");
    await logProgress(userId, u, "OK");

  } else {

    // ============================
    //   НЕПРАВИЛЬНЫЙ ОТВЕТ
    // ============================

    // сбиваем streak
    u.streak = 0;

    if (u.points > 0) u.points -= 1;

    u.nextLessonAt = Date.now() + 30 * 60 * 1000; // 30 минут

    await ctx.reply("❌ Ошибка. Балл снят. Этот же урок придёт через 30 минут.");
    await logProgress(userId, u, "FAIL");
  }

  await saveUser(userId, u);
});



// ======================================================
// АВТО-ОТПРАВКА УРОКОВ
// ======================================================

setInterval(async () => {
  const snapshot = await db.collection("users").get();
  const now = Date.now();

  for (const doc of snapshot.docs) {
    const userId = doc.id;
    const u = doc.data();

    if (u.finished) continue;
    if (u.waitingAnswer) continue;
    if (!u.nextLessonAt || now < u.nextLessonAt) continue;

    await sendLesson(userId, u.currentLesson);
  }
}, 20000);

// ======================================================
// WEBHOOK / POLLING
// ======================================================

if (WEBHOOK_URL) {
  bot.telegram.setWebhook(WEBHOOK_URL);
  app.use(bot.webhookCallback("/telegram-webhook"));

  app.get("/", (_, res) => res.send("Bot is running"));

  app.listen(PORT, () => console.log("Server OK:", PORT));
} else {
  console.log("▶ Запуск POLLING");
  bot.launch();
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));