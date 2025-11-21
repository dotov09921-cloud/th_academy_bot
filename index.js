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

const OWNER_ID = 8097671685; // твой ID для /news

// ======================================================
// FIRESTORE
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

  // Меню
  await ctx.reply(
    "Меню:",
    Markup.keyboard([
      ["Итог ⭐", "Рейтинг 🏆"]
    ]).resize()
  );

  if (saved) {
    usersCache[userId] = saved;
    return ctx.reply(`С возвращением, ${saved.name}! Продолжаем обучение 📚`);
  }

  tempUsers[userId] = { step: "name" };
  ctx.reply("Привет! Напиши своё имя:");
});

// ======================================================
// КНОПКА Итог ⭐
// ======================================================

bot.hears("Итог ⭐", async ctx => {
  const userId = ctx.from.id;
  let u = usersCache[userId] || await loadUser(userId);

  if (!u) return ctx.reply("Вы ещё не начали обучение. Нажмите /start");

  const text = `
📌 *Ваши итоги обучения:*

👤 Имя: *${u.name}*
🎭 Статус: *${u.role || "не выбран"}*
📚 Урок: *${u.currentLesson || 1} / 90*
⭐ Баллы: *${u.points || 0}*
🔥 Серия правильных: *${u.streak || 0}*
  `;

  ctx.reply(text, { parse_mode: "Markdown" });
});

// ======================================================
// КНОПКА Рейтинг 🏆
// ======================================================

bot.hears("Рейтинг 🏆", async ctx => {
  const snapshot = await db.collection("users").get();

  let users = [];
  snapshot.forEach(doc => {
    const u = doc.data();
    users.push({
      name: u.name || "Без имени",
      points: u.points || 0
    });
  });

  users.sort((a, b) => b.points - a.points);
  const top = users.slice(0, 10);

  if (top.length === 0) return ctx.reply("Рейтинг пока пуст.");

  let text = "🏆 *ТОП-10 участников:*\n\n";
  top.forEach((u, i) => {
    text += `${i + 1}) *${u.name}* — ${u.points} баллов\n`;
  });

  ctx.reply(text, { parse_mode: "Markdown" });
});

// ======================================================
// КОМАНДА /news — рассылка новости всем
// ======================================================

bot.command("news", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав отправлять новости.");
  }

  const text = ctx.message.text.split(" ").slice(1).join(" ").trim();

  if (!text) {
    return ctx.reply("Напишите текст новости:\n/news Завтра важное обновление.");
  }

  const snapshot = await db.collection("users").get();

  let sent = 0;

  for (const doc of snapshot.docs) {
    const uid = doc.id;

    try {
      await bot.telegram.sendMessage(
        Number(uid),
        `🛠 *Техподдержка*\n\n${text}`,
        { parse_mode: "Markdown" }
      );
      sent++;
    } catch (err) {
      console.error("Ошибка:", uid, err.message);
    }
  }

  ctx.reply(`✔ Новость отправлена ${sent} пользователям.`);
});

// ======================================================
// ТЕКСТОВАЯ РЕГИСТРАЦИЯ
// ======================================================

bot.on("text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (tempUsers[userId]?.step === "name") {
    const userState = {
      name: text,
      currentLesson: 1,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
      points: 0,
      streak: 0,
      role: null,
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
  const u = usersCache[ctx.from.id] || (await loadUser(ctx.from.id));
  if (!u) return;

  u.role = "сотрудник";
  await saveUser(ctx.from.id, u);

  await ctx.reply("Статус сохранён: 👨‍🔧 Сотрудник");
  return sendLesson(ctx.from.id, u.currentLesson);
});

bot.action("role_client", async ctx => {
  const u = usersCache[ctx.from.id] || (await loadUser(ctx.from.id));
  if (!u) return;

  u.role = "клиент";
  await saveUser(ctx.from.id, u);

  await ctx.reply("Статус сохранён: 🧑 Клиент");
  return sendLesson(ctx.from.id, u.currentLesson);
});

// ======================================================
// ОБРАБОТКА ОТВЕТОВ
// ======================================================

bot.on("callback_query", async ctx => {
  const userId = ctx.from.id;
  const answer = ctx.callbackQuery.data;

  if (answer.startsWith("role_")) return;

  const u = usersCache[userId] || (await loadUser(userId));
  if (!u || !u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  u.waitingAnswer = false;

  if (answer === lesson.correct) {
    u.streak = (u.streak || 0) + 1;
    u.points = (u.points || 0) + 1;

    if (u.streak === 3) {
      u.points++;
      u.streak = 0;
      await ctx.reply("🔥 Отлично! 3 правильных подряд — бонус +1 балл!");
    }

    u.currentLesson++;
    u.nextLessonAt = Date.now() + 10 * 1000;

    await ctx.reply("✅ Правильно! Следующий урок — через 24 часа.");
    await logProgress(userId, u, "OK");

  } else {
    u.streak = 0;
    if (u.points && u.points > 0) u.points--;

    u.nextLessonAt = Date.now() + 10 * 1000;

    await ctx.reply("❌ Ошибка. Балл снят. Через 30 минут попробуешь снова.");
    await logProgress(userId, u, "FAIL");
  }

  await saveUser(userId, u);
});

// ======================================================
// АВТО-ОТПРАВКА
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
  app.listen(PORT, () => console.log("Server OK:", PORT));
} else {
  bot.launch();
  console.log("▶ Запуск POLLING");
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// hh