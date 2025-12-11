require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
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
app.get("/ping", (req, res) => {
  res.status(200).send("OK");
});

// Главная клавиатура
const mainKeyboard = Markup.keyboard([
  ["▶️ Старт"],
  ["Итог ⭐", "Рейтинг 🏆"],
  ["⏳ Осталось времени"]
]).resize();

// ======================================================
// ВРЕМЕННЫЕ ХРАНИЛИЩА
// ======================================================

const tempUsers = {};
const usersCache = {};

// 🔐 ID админа
const OWNER_ID = 8097671685;

// ======================================================
// SMS.RU (пока не используется, оставлен на будущее)
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
// FIRESTORE HELPERS
// ======================================================

async function loadUser(userId) {
  const doc = await db.collection("users").doc(String(userId)).get();
  return doc.exists ? doc.data() : null;
}

async function saveUser(userId, data) {
  await db.collection("users").doc(String(userId)).set(data, { merge: true });
  usersCache[userId] = { ...(usersCache[userId] || {}), ...data };
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
    question: lesson.questionText,
    userAnswer,
    correctAnswer: lesson.correct,
    ts: Date.now(),
  });
}

// небольшая утилита для разрыва страниц в PDF (может пригодиться)
function ensureSpace(doc, need = 80) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) {
    doc.addPage();
  }
}

// ======================================================
// ОТПРАВКА УРОКА (ТОЛЬКО МАТЕРИАЛ, БЕЗ ВОПРОСА)
// ======================================================

async function sendLesson(userId, lessonNumber) {
  const chatId = Number(userId);
  const lesson = lessons[lessonNumber];

  if (!lesson) {
    await bot.telegram.sendMessage(chatId, "🎉 Все 90 уроков пройдены! Молодец!");

    const u = (usersCache[userId] || await loadUser(userId)) || {};
    u.finished = true;
    u.waitingAnswer = false;
    u.nextLessonAt = 0;
    u.nextQuestionAt = 0;
    await saveUser(userId, u);
    return;
  }

  const sentLesson = await bot.telegram.sendMessage(
    chatId,
    `📘 Урок ${lessonNumber}\n\n${lesson.lessonText}\n\n⏳ Через 1 час придёт вопрос по этой теме.`
  );

  const u = (usersCache[userId] || await loadUser(userId)) || {};
  u.currentLesson = lessonNumber;
  u.lastLessonMessageId = sentLesson.message_id;  // запоминаем ID урока
  u.waitingAnswer = false;
  u.lastLessonAt = Date.now();
  u.nextLessonAt = 0;                             // следующий урок назначим после ответа
  u.nextQuestionAt = Date.now() + 60 * 60 * 1000; // вопрос через 1 час

  await saveUser(userId, u);
}

// ======================================================
// ОТПРАВКА ВОПРОСА ПО УРОКУ (С УДАЛЕНИЕМ УРОКА)
// ======================================================

async function sendQuestion(userId, lessonNumber) {
  const chatId = Number(userId);
  const u = (usersCache[userId] || await loadUser(userId)) || {};
  const lesson = lessons[lessonNumber];

  if (!lesson) return;

  // Удаляем учебный материал, если он ещё висит
  if (u.lastLessonMessageId) {
    try {
      await bot.telegram.deleteMessage(chatId, u.lastLessonMessageId);
    } catch (e) {
      console.log("⚠️ Не удалось удалить сообщение с уроком:", e.message);
    }
    u.lastLessonMessageId = null;
  }

  const keyboard = Markup.inlineKeyboard(
    lesson.buttons.map(b => [Markup.button.callback(b[0], b[0])])
  );

  await bot.telegram.sendMessage(
    chatId,
    `❓ Вопрос по уроку ${lessonNumber}\n\n${lesson.questionText}`,
    keyboard
  );

  u.waitingAnswer = true;
  u.nextQuestionAt = 0;

  await saveUser(userId, u);
}

// ======================================================
// ПОВТОРНАЯ ОТПРАВКА АКТИВНОГО ВОПРОСА
// ======================================================

async function resendCurrentQuestion(ctx, u) {
  if (!u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  if (!lesson) return;

  const keyboard = Markup.inlineKeyboard(
    lesson.buttons.map(b => [Markup.button.callback(b[0], b[0])])
  );

  await ctx.reply(
    `❓ Вопрос по уроку ${u.currentLesson}\n\n${lesson.questionText}`,
    keyboard
  );
}

// ======================================================
// ОБРАБОТЧИК /start и кнопки "▶️ Старт"
// ======================================================

async function handleStart(ctx) {
  const userId = ctx.from.id;
  const saved = await loadUser(userId);

  await ctx.reply("Меню:", mainKeyboard);

  if (saved && saved.verified) {
    usersCache[userId] = saved;

    // 1️⃣ Если есть активный вопрос — дублируем вопрос
    if (saved.waitingAnswer) {
      await ctx.reply("У тебя уже есть активный вопрос. Дублирую его 👇");
      await resendCurrentQuestion(ctx, saved);
      return;
    }

    // 2️⃣ Если урок уже выслан, а вопрос ещё не пришёл — дублируем урок
    const now = Date.now();
    if (saved.nextQuestionAt && saved.nextQuestionAt > now && !saved.finished) {
      const lesson = lessons[saved.currentLesson];
      if (lesson) {
        await ctx.reply(
          `📘 Урок ${saved.currentLesson}\n\n${lesson.lessonText}\n\n⏳ Вопрос по этой теме уже запланирован, дождись уведомления.`
        );
      }
      return;
    }

    // 3️⃣ Обычное приветствие
    return ctx.reply(`С возвращением, ${saved.name}! Продолжаем обучение 📚`);
  }

  // 4️⃣ Новая регистрация
  tempUsers[userId] = { step: "name" };
  ctx.reply("Привет! Напиши своё имя:");
}

bot.start(handleStart);
bot.hears("▶️ Старт", handleStart);

// ======================================================
// КНОПКА "Итог ⭐"
// ======================================================

bot.hears("Итог ⭐", async ctx => {
  const userId = ctx.from.id;
  const u = usersCache[userId] || await loadUser(userId);

  if (!u || !u.verified)
    return ctx.reply("Вы ещё не прошли регистрацию. Нажмите ▶️ Старт");

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
// КНОПКА "Рейтинг 🏆"
// ======================================================

bot.hears("Рейтинг 🏆", async ctx => {
  const snapshot = await db.collection("users").get();

  const users = [];
  snapshot.forEach(doc => {
    const u = doc.data();
    users.push({
      id: doc.id,
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
// КНОПКА "⏳ Осталось времени"
// ======================================================

bot.hears("⏳ Осталось времени", async ctx => {
  const userId = ctx.from.id;
  const u = usersCache[userId] || await loadUser(userId);

  if (!u || !u.verified) {
    return ctx.reply("Сначала нажми ▶️ Старт и пройди быструю регистрацию.");
  }

  if (u.waitingAnswer) {
    return ctx.reply("Сейчас у тебя есть активный вопрос — отвечай на него 👇");
  }

  const now = Date.now();
  const parts = [];

  if (u.nextQuestionAt && u.nextQuestionAt > now) {
    const diffQ = u.nextQuestionAt - now;
    const hoursQ = Math.floor(diffQ / (1000 * 60 * 60));
    const minutesQ = Math.floor((diffQ % (1000 * 60 * 60)) / (1000 * 60));

    let line = "❓ До вопроса по текущему уроку осталось:\n";
    if (hoursQ > 0) line += `• ${hoursQ} ч\n`;
    line += `• ${minutesQ} мин`;
    parts.push(line);
  }

  if (u.nextLessonAt && u.nextLessonAt > now) {
    const diffL = u.nextLessonAt - now;
    const hoursL = Math.floor(diffL / (1000 * 60 * 60));
    const minutesL = Math.floor((diffL % (1000 * 60 * 60)) / (1000 * 60));

    let line = "📘 До следующего урока осталось:\n";
    if (hoursL > 0) line += `• ${hoursL} ч\n`;
    line += `• ${minutesL} мин`;
    parts.push(line);
  }

  if (!parts.length) {
    return ctx.reply("🔥 Все таймеры отработали. Скоро придёт новый урок или вопрос автоматически.");
  }

  await ctx.reply(parts.join("\n\n"));
});

// ======================================================
// КОМАНДА /news (только админ)
// ======================================================

bot.command("news", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав отправлять новости.");
  }

  const args = ctx.message.text.split(" ").slice(1).join(" ").trim();
  const replied = ctx.message.reply_to_message;

  if (!args && !replied) {
    return ctx.reply("Отправьте фото/видео/документ, затем ответьте на него:\n/news Текст новости");
  }

  const snapshot = await db.collection("users").get();
  let sent = 0;

  for (const doc of snapshot.docs) {
    const uid = Number(doc.id);

    try {
      if (replied) {
        if (replied.photo) {
          const fileId = replied.photo[replied.photo.length - 1].file_id;
          await ctx.telegram.sendPhoto(uid, fileId, { caption: args || "" });
        } else if (replied.video) {
          await ctx.telegram.sendVideo(uid, replied.video.file_id, { caption: args || "" });
        } else if (replied.document) {
          await ctx.telegram.sendDocument(uid, replied.document.file_id, { caption: args || "" });
        } else if (replied.voice) {
          await ctx.telegram.sendVoice(uid, replied.voice.file_id, { caption: args || "" });
        } else if (replied.text) {
          await ctx.telegram.sendMessage(uid, replied.text + "\n\n" + args);
        }
      } else {
        await ctx.telegram.sendMessage(
          uid,
          `🛠 *Техподдержка*\n\n${args}`,
          { parse_mode: "Markdown" }
        );
      }

      sent++;
    } catch (err) {
      console.error("Ошибка отправки пользователю", uid, err.message);
    }
  }

  ctx.reply(`✔ Новость отправлена: ${sent} пользователям.`);
});

// ======================================================
// /mistakes [userId] — ошибки пользователя (только админ)
// ======================================================

bot.command("mistakes", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав просматривать ошибки.");
  }

  const args = ctx.message.text.split(" ").slice(1);
  let targetId = args[0] ? args[0].trim() : String(ctx.from.id);

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
// /stats — общая статистика (только админ)
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
// /pdf30 — простой PDF за 30 дней (только админ)
// ======================================================

bot.command("pdf30", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав на просмотр отчёта.");
  }

  try {
    await ctx.reply("⏳ Готовлю простой PDF-отчёт за последние 30 дней…");

    const filePath = path.join(__dirname, "report_30days.pdf");
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const progressSnap = await db.collection("progress")
      .where("ts", ">", since)
      .get();

    let totalOK = 0;
    let totalFAIL = 0;

    progressSnap.forEach(p => {
      const data = p.data();
      if (data.result === "OK") totalOK++;
      else totalFAIL++;
    });

    const total = totalOK + totalFAIL;
    const percent = total === 0 ? 0 : Math.round((totalOK / total) * 100);

    doc.fontSize(22).text("Technocolor Academy", { align: "center" });
    doc.moveDown();
    doc.fontSize(18).text("Отчёт за последние 30 дней", { align: "center" });
    doc.moveDown(2);

    doc.fontSize(14).text(`Всего ответов: ${total}`);
    doc.text(`Правильных: ${totalOK}`);
    doc.text(`Ошибок: ${totalFAIL}`);
    doc.text(`Точность: ${percent}%`);
    doc.moveDown(2);

    doc.text("Отчёт сформирован автоматически системой Technocolor Academy.");
    doc.end();

    stream.on("finish", async () => {
      await ctx.replyWithDocument({
        source: filePath,
        filename: "report_30days.pdf"
      });
      fs.unlinkSync(filePath);
    });

  } catch (err) {
    console.error("Ошибка PDF:", err);
    ctx.reply("❌ Ошибка при создании PDF. Подробности в логах.");
  }
});

// ======================================================
// ПОЛНЫЙ ОТЧЁТ: buildFullReport30Days (упрощённый вариант)
// ======================================================

async function buildFullReport30Days(filePath) {
  return new Promise(async (resolve, reject) => {
    try {
      const now = Date.now();
      const since = now - 30 * 24 * 60 * 60 * 1000;

      const [usersSnap, progressSnap] = await Promise.all([
        db.collection("users").get(),
        db.collection("progress").where("ts", ">", since).get()
      ]);

      const usersCount = usersSnap.size;
      const totalCorrect = progressSnap.docs.filter(p => p.data().result === "OK").length;
      const totalWrong = progressSnap.docs.filter(p => p.data().result === "FAIL").length;
      const total = totalCorrect + totalWrong;
      const accuracy = total === 0 ? 0 : Math.round((totalCorrect / total) * 100);

      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      doc.fontSize(24).text("Technocolor Academy", { align: "center" });
      doc.moveDown();
      doc.fontSize(18).text("Расширенный отчёт за последние 30 дней", { align: "center" });
      doc.moveDown(2);

      doc.fontSize(12).text(`Дата формирования: ${new Date().toLocaleString("ru-RU")}`);
      doc.text(`Всего пользователей в системе: ${usersCount}`);
      doc.moveDown();

      doc.text(`Всего ответов за 30 дней: ${total}`);
      doc.text(`Правильных: ${totalCorrect}`);
      doc.text(`Ошибок: ${totalWrong}`);
      doc.text(`Средняя точность: ${accuracy}%`);
      doc.moveDown(2);

      doc.text("Отчёт сформирован автоматически системой Technocolor Academy.");

      doc.end();

      stream.on("finish", () => resolve());
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

// ======================================================
// /pdf_full — расширенная аналитика (только админ)
// ======================================================

bot.command("pdf_full", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав на просмотр расширенного отчёта.");
  }

  try {
    await ctx.reply("⏳ Формирую расширенный PDF-отчёт за последние 30 дней…");

    const filePath = path.join(__dirname, `report_full_30days_${Date.now()}.pdf`);

    await buildFullReport30Days(filePath);

    await ctx.replyWithDocument({
      source: filePath,
      filename: "Technocolor_Report_30days_full.pdf"
    });

    fs.unlinkSync(filePath);
  } catch (err) {
    console.error("Ошибка pdf_full:", err);
    ctx.reply("❌ Ошибка при создании расширенного PDF. Подробности в логах.");
  }
});

// ======================================================
// /reset_lessons — сбросить уроки и начать с 1-го (только админ)
// ======================================================

bot.command("reset_lessons", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав сбрасывать уроки.");
  }

  try {
    const snapshot = await db.collection("users").get();
    let count = 0;

    for (const doc of snapshot.docs) {
      const userId = doc.id;
      const u = doc.data() || {};

      const updated = {
        ...u,
        currentLesson: 1,
        finished: false,
        waitingAnswer: false,
        nextLessonAt: 0,
        nextQuestionAt: 0,
        streak: 0,
        lastLessonMessageId: null
      };

      await saveUser(userId, updated);
      await sendLesson(userId, 1);
      count++;
    }

    ctx.reply(`✔ Уроки сброшены. Всем отправлен Урок 1 по новой системе. Пользователей: ${count}.`);
  } catch (err) {
    console.error("Ошибка reset_lessons:", err);
    ctx.reply("❌ Ошибка при сбросе уроков. Подробности в логах.");
  }
});

// ======================================================
// РЕГИСТРАЦИЯ — имя
// ======================================================

bot.on("text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

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
});

// ======================================================
// РЕГИСТРАЦИЯ — телефон
// ======================================================

bot.on("contact", async ctx => {
  const userId = ctx.from.id;

  if (tempUsers[userId]?.step !== "phone") return;

  const phone = ctx.message.contact.phone_number;
  const tmp = tempUsers[userId] || {};
  const name = tmp.name || ctx.from.first_name || "Без имени";

  const userState = {
    name,
    phone,
    verified: true,
    currentLesson: 1,
    waitingAnswer: false,
    nextLessonAt: 0,
    lastLessonAt: 0,
    nextQuestionAt: 0,
    points: 0,
    streak: 0,
    role: null,
    correctCount: 0,
    wrongCount: 0,
    lastLessonMessageId: null
  };

  await saveUser(userId, userState);
  usersCache[userId] = userState;

  delete tempUsers[userId];

  await ctx.reply("Номер сохранён ✅", {
    reply_markup: { remove_keyboard: true }
  });

  await ctx.reply("Меню:", mainKeyboard);

  await ctx.reply(
    "Выберите статус:",
    Markup.inlineKeyboard([
      [Markup.button.callback("👨‍🔧 Сотрудник", "role_employee")],
      [Markup.button.callback("🧑 Клиент", "role_client")],
    ])
  );
});

// ======================================================
// ВЫБОР РОЛИ
// ======================================================

bot.action("role_employee", async ctx => {
  const userId = ctx.from.id;
  const u = usersCache[userId] || await loadUser(userId);
  if (!u) return;

  u.role = "сотрудник";
  await saveUser(userId, u);

  await ctx.reply("Статус сохранён: 👨‍🔧 Сотрудник");
  return sendLesson(userId, u.currentLesson || 1);
});

bot.action("role_client", async ctx => {
  const userId = ctx.from.id;
  const u = usersCache[userId] || await loadUser(userId);
  if (!u) return;

  u.role = "клиент";
  await saveUser(userId, u);

  await ctx.reply("Статус сохранён: 🧑 Клиент");
  return sendLesson(userId, u.currentLesson || 1);
});

// ======================================================
// ОБРАБОТКА ОТВЕТОВ НА ВОПРОСЫ (callback_query)
// ======================================================

bot.on("callback_query", async ctx => {
  const userId = ctx.from.id;
  const answer = ctx.callbackQuery.data;

  // роли уже обработаны в bot.action("role_...")
  if (answer.startsWith("role_")) return;

  const u = usersCache[userId] || await loadUser(userId);
  if (!u || !u.waitingAnswer) return;

  const lesson = lessons[u.currentLesson];
  if (!lesson) return;

  u.waitingAnswer = false;

  if (answer === lesson.correct) {
    // правильный ответ
    u.streak = (u.streak || 0) + 1;
    u.points = (u.points || 0) + 1;
    u.correctCount = (u.correctCount || 0) + 1;

    if (u.streak === 3) {
      u.points++;
      u.streak = 0;
      await ctx.reply("🔥 Отлично! 3 правильных подряд — бонус +1 балл!");
    }

    u.currentLesson = (u.currentLesson || 1) + 1;
    u.nextLessonAt = Date.now() + 24 * 60 * 60 * 1000; // следующий урок через 24 часа
    u.nextQuestionAt = 0; // вопрос назначим после нового урока

    await ctx.reply("✅ Правильно! Новый урок придёт через 24 часа.");
    await logProgress(userId, u, "OK");
  } else {
    // неправильный ответ
    u.streak = 0;
    if (u.points && u.points > 0) u.points--;
    u.wrongCount = (u.wrongCount || 0) + 1;

    // повтор этого же урока через 30 минут
    u.nextLessonAt = Date.now() + 30 * 60 * 1000;
    u.nextQuestionAt = 0;

    await ctx.reply("❌ Ошибка. Балл снят. Через 30 минут повторим урок, потом придёт новый вопрос.");
    await logProgress(userId, u, "FAIL");
    await logMistake(userId, u.currentLesson, lesson, answer);
  }

  await saveUser(userId, u);
});

// ======================================================
// АВТО-ОТПРАВКА УРОКОВ И ВОПРОСОВ ПО ТАЙМЕРАМ
// ======================================================

setInterval(async () => {
  const snapshot = await db.collection("users").get();
  const now = Date.now();

  for (const doc of snapshot.docs) {
    const userId = doc.id;
    const u = doc.data();

    if (u.finished) continue;

    // если ждём ответ – ничего не шлём
    if (u.waitingAnswer) continue;

    // 1) сначала вопрос (важнее)
    if (u.nextQuestionAt && now >= u.nextQuestionAt) {
      await sendQuestion(userId, u.currentLesson || 1);
      continue;
    }

    // 2) потом урок
    if (u.nextLessonAt && now >= u.nextLessonAt) {
      await sendLesson(userId, u.currentLesson || 1);
    }
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