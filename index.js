require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
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

// Главная клавиатура
const mainKeyboard = Markup.keyboard([
  ["▶️ Старт"],
  ["Итог ⭐", "Рейтинг 🏆"]
]).resize();

// ======================================================
// ВРЕМЕННЫЕ ХРАНИЛИЩА
// ======================================================

const tempUsers = {};
const usersCache = {};

// 🔐 ID админа
const OWNER_ID = 8097671685;

// ======================================================
// SMS.RU
// ======================================================

async function sendSmsCode(phone, code) {
  try {
    const apiId = process.env.SMS_API_ID;
    if (!apiId) {
      console.error("❌ Нет SMS_API_ID в .env");
      return null;
    }

    const cleanPhone = phone.replace(/[^\d]/g, '');

    const url = `https://sms.ru/sms/send?api_id=${apiId}&to=${cleanPhone}&msg=${encodeURIComponent(
      'Ваш код подтверждения: ' + code
    )}&json=1`;

    const res = await axios.get(url);
    console.log("Ответ SMS.ru:", res.data);
    return res.data;
  } catch (err) {
    console.error("Ошибка отправки СМС:", err.message);
    return null;
  }
}

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
    userId: String(userId),
    name: state.name,
    lesson: state.currentLesson,
    result,
    points: state.points,
    ts: Date.now(),
  });
}

async function logMistake(userId, lessonNumber, lesson, userAnswer) {
  await db.collection("mistakes").add({
    userId: String(userId),
    lesson: lessonNumber,
    question: lesson.question,
    userAnswer,
    correctAnswer: lesson.correct,
    ts: Date.now(),
  });
}

// ======================================================
// ОТПРАВКА УРОКА (НОВЫЙ)
// ======================================================

async function sendLesson(userId, lessonNumber) {
  const chatId = Number(userId);
  const lesson = lessons[lessonNumber];

  if (!lesson) {
    await bot.telegram.sendMessage(chatId, "🎉 Все 90 уроков пройдены! Молодец!");

    const u = usersCache[userId];
    if (u) {
      u.finished = true;
      u.waitingAnswer = false;
      u.nextLessonAt = null;
      await saveUser(userId, u);
    }
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

  const u = usersCache[userId] || (await loadUser(userId));
  if (!u) return;

  u.waitingAnswer = true;
  u.lastLessonAt = Date.now();
  u.nextLessonAt = 0;

  await saveUser(userId, u);
}

// ======================================================
// ПОВТОРНАЯ ОТПРАВКА УЖЕ ВЫДАННОГО ВОПРОСА
// ======================================================

async function resendCurrentQuestion(ctx, u) {
  // защита: если нет активного вопроса — ничего не делаем
  if (!u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  if (!lesson) return;

  const keyboard = Markup.inlineKeyboard(
    lesson.buttons.map(b => [Markup.button.callback(b[0], b[0])])
  );

  await ctx.reply(
    `📘 Урок ${u.currentLesson}\n\n${lesson.text}\n\n${lesson.question}`,
    keyboard
  );
}

// ======================================================
// ОБЩИЙ ОБРАБОТЧИК СТАРТА (/start и "▶️ Старт")
// ======================================================

async function handleStart(ctx) {
  const userId = ctx.from.id;
  const saved = await loadUser(userId);

  // Всегда показываем основное меню
  await ctx.reply("Меню:", mainKeyboard);

  if (saved && saved.verified) {
    usersCache[userId] = saved;

    // Если у пользователя уже "висит" вопрос — просто дублируем его
    if (saved.waitingAnswer) {
      await ctx.reply("У тебя уже есть активный вопрос. Дублирую его 👇");
      await resendCurrentQuestion(ctx, saved);
      return;
    }

    // Если активного вопроса нет — просто приветствие, ждём авто-урок по расписанию
    return ctx.reply(`С возвращением, ${saved.name}! Продолжаем обучение 📚`);
  }

  // Если не зарегистрирован / не верифицирован — запускаем регистрацию
  tempUsers[userId] = { step: "name" };
  ctx.reply("Привет! Напиши своё имя:");
}

// ======================================================
// /start и кнопка "▶️ Старт"
// ======================================================

bot.start(handleStart);
bot.hears("▶️ Старт", handleStart);

// ======================================================
// КНОПКА Итог ⭐
// ======================================================

bot.hears("Итог ⭐", async ctx => {
  const userId = ctx.from.id;
  let u = usersCache[userId] || await loadUser(userId);

  if (!u || !u.verified) return ctx.reply("Вы ещё не прошли регистрацию. Нажмите ▶️ Старт");

  const totalCorrect = u.correctCount || 0;
  const totalWrong = u.wrongCount || 0;
  const totalAnswers = totalCorrect + totalWrong;
  const percent = totalAnswers === 0 ? 0 : Math.round((totalCorrect / totalAnswers) * 100);

  const text = `
📌 *Ваши итоги обучения:*

👤 Имя: *${u.name}*
📱 Телефон: *${u.phone || "-"}*
🎭 Статус: *${u.role || "не выбран"}*
📚 Урок: *${u.currentLesson || 1} / 90*
⭐ Баллы: *${u.points || 0}*
🔥 Серия правильных: *${u.streak || 0}*
📈 Точность ответов: *${percent}%*  (правильных: ${totalCorrect}, ошибок: ${totalWrong})
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

  let text = "🏆 *ТОП-10 участников по баллам:*\n\n";
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
// КОМАНДА /mistakes [userId] — ошибки пользователя (ТОЛЬКО АДМИН)
// ======================================================

bot.command("mistakes", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав просматривать ошибки.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  let targetId = args[0] ? args[0].trim() : null;

  if (!targetId) {
    targetId = String(ctx.from.id);
  }

  try {
    const userData = await loadUser(targetId);

    if (!userData) {
      return ctx.reply(
        `Пользователь с ID *${targetId}* не найден.`,
        { parse_mode: "Markdown" }
      );
    }

    const correctCount = userData.correctCount || 0;
    const wrongCount = userData.wrongCount || 0;
    const totalAnswers = correctCount + wrongCount;
    const percent = totalAnswers === 0 ? 0 : Math.round((correctCount / totalAnswers) * 100);

    const snapshot = await db.collection("mistakes")
      .where("userId", "==", String(targetId))
      .limit(20)
      .get();

    if (snapshot.empty) {
      return ctx.reply(
        `У пользователя *${userData.name}* (ID ${targetId}) нет ошибок.`,
        { parse_mode: "Markdown" }
      );
    }

    let text = `❌ *Ошибки пользователя ${userData.name}* (ID ${targetId}):\n\n`;
    text += `Правильных: *${correctCount}*, ошибок: *${wrongCount}*, точность: *${percent}%*\n\n`;

    snapshot.forEach(doc => {
      const m = doc.data();
      const date = new Date(m.ts).toLocaleString("ru-RU");
      text += `📅 ${date}\n`;
      text += `Урок ${m.lesson}\n`;
      text += `Вопрос: ${m.question}\n`;
      text += `Ответил: *${m.userAnswer}*\n`;
      text += `Правильно: *${m.correctAnswer}*\n\n`;
    });

    ctx.reply(text, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Ошибка в /mistakes:", err);
    ctx.reply("Произошла ошибка при загрузке ошибок. Проверь консоль сервера.");
  }
});

// ======================================================
// КОМАНДА /stats — общая статистика (ТОЛЬКО АДМИН)
// ======================================================

bot.command("stats", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав просматривать статистику.");
  }

  const snapshot = await db.collection("users").get();

  let totalCorrect = 0;
  let totalWrong = 0;
  let usersCount = 0;

  snapshot.forEach(doc => {
    const u = doc.data();
    totalCorrect += u.correctCount || 0;
    totalWrong += u.wrongCount || 0;
    usersCount++;
  });

  const totalAnswers = totalCorrect + totalWrong;
  const percent =
    totalAnswers === 0 ? 0 : Math.round((totalCorrect / totalAnswers) * 100);

  const text = `
📊 *Общая статистика Technocolor Academy:*

👥 Участников: *${usersCount}*

🟢 Правильных ответов: *${totalCorrect}*
🔴 Неправильных ответов: *${totalWrong}*

📌 Всего ответов: *${totalAnswers}*

⭐ *Средний процент правильных по системе: ${percent}%*
`;

  ctx.reply(text, { parse_mode: "Markdown" });
});

// ======================================================
// КОМАНДА /reset_all — полный сброс (ТОЛЬКО АДМИН)
// ======================================================

bot.command("reset_all", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав на полный сброс системы.");
  }

  try {
    ctx.reply("⏳ Выполняю полный сброс Academy…");

    const usersSnap = await db.collection("users").get();
    for (const doc of usersSnap.docs) {
      await doc.ref.delete();
    }

    const mistakesSnap = await db.collection("mistakes").get();
    for (const doc of mistakesSnap.docs) {
      await doc.ref.delete();
    }

    const progressSnap = await db.collection("progress").get();
    for (const doc of progressSnap.docs) {
      await doc.ref.delete();
    }

    ctx.reply("✔ Полный сброс завершён. Все lesson'ы теперь начнутся заново.");
  } catch (err) {
    console.error("Ошибка reset_all:", err);
    ctx.reply("❌ Ошибка при сбросе. Подробности в серверной консоли.");
  }
});

// ======================================================
// ТЕКСТ + ВЕРИФИКАЦИЯ КОДА
// ======================================================

bot.on("text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // 1) проверка СМС-кода
  if (tempUsers[userId]?.step === "verify") {
    const correctCode = tempUsers[userId].code;

    if (text === String(correctCode)) {
      const tmp = tempUsers[userId];

      const userState = {
        name: tmp.name,
        phone: tmp.phone,
        verified: true,
        currentLesson: 1,
        waitingAnswer: false,
        nextLessonAt: 0,
        lastLessonAt: 0,
        points: 0,
        streak: 0,
        role: null,
        correctCount: 0,
        wrongCount: 0,
      };

      await saveUser(userId, userState);
      usersCache[userId] = userState;

      delete tempUsers[userId];

      return ctx.reply(
        "Телефон подтверждён ✅\nТеперь выбери свой статус:",
        Markup.inlineKeyboard([
          [Markup.button.callback("👨‍🔧 Сотрудник", "role_employee")],
          [Markup.button.callback("🧑 Клиент", "role_client")],
        ])
      );
    } else {
      return ctx.reply("❌ Неверный код. Попробуйте ещё раз:");
    }
  }

  // 2) ввод имени
  if (tempUsers[userId]?.step === "name") {
    tempUsers[userId].name = text;
    tempUsers[userId].step = "phone";

    return ctx.reply(
      "Теперь отправь свой номер телефона 👇",
      Markup.keyboard([
        Markup.button.contactRequest("Отправить номер 📱")
      ]).resize()
    );
  }

  // остальные текстовые сообщения не трогаем
});

// ======================================================
// ПОЛУЧЕНИЕ КОНТАКТА (ТЕЛЕФОНА)
// ======================================================

bot.on("contact", async ctx => {
  const userId = ctx.from.id;

  if (tempUsers[userId]?.step !== "phone") return;

  const phone = ctx.message.contact.phone_number;
  tempUsers[userId].phone = phone;

  const code = Math.floor(1000 + Math.random() * 9000);
  tempUsers[userId].code = code;
  tempUsers[userId].step = "verify";

  await sendSmsCode(phone, code);

  return ctx.reply("Мы отправили вам СМС с кодом. Введите код из сообщения:");
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
// ОБРАБОТКА ОТВЕТОВ НА УРОКИ
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
    u.correctCount = (u.correctCount || 0) + 1;

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
    u.wrongCount = (u.wrongCount || 0) + 1;

    u.nextLessonAt = Date.now() + 10 * 1000;

    await ctx.reply("❌ Ошибка. Балл снят. Через 30 минут попробуешь снова.");
    await logProgress(userId, u, "FAIL");
    await logMistake(userId, u.currentLesson, lesson, answer);
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
  app.listen(PORT, () => console.log("Server OK:", PORT));
} else {
  bot.launch();
  console.log("▶️ Запуск POLLING");
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));