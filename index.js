require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const PDFDocument = require('pdfkit');   // для PDF
const fs = require('fs');                // для временного файла
const path = require('path');            // безопасные пути
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
// SMS.RU (сейчас НЕ используется, но оставлен на будущее)
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
// FIRESTORE ХЕЛПЕРЫ
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

// небольшая утилита для разрыва страниц
function ensureSpace(doc, need = 80) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + need > bottom) {
    doc.addPage();
  }
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
// ОБЩИЙ ОБРАБОТЧИК СТАРТА
// ======================================================

async function handleStart(ctx) {
  const userId = ctx.from.id;
  const saved = await loadUser(userId);

  await ctx.reply("Меню:", mainKeyboard);

  if (saved && saved.verified) {
    usersCache[userId] = saved;

    if (saved.waitingAnswer) {
      await ctx.reply("У тебя уже есть активный вопрос. Дублирую его 👇");
      await resendCurrentQuestion(ctx, saved);
      return;
    }

    return ctx.reply(`С возвращением, ${saved.name}! Продолжаем обучение 📚`);
  }

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


{
    text: "⏳ Осталось времени",
    callback_data: "check_time"
}

// ======================================================
// КНОПКА Рейтинг 🏆
// ======================================================

bot.hears("Рейтинг 🏆", async ctx => {
  const snapshot = await db.collection("users").get();

  let users = [];
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
// КОМАНДА /news — поддержка медиа через reply (ТОЛЬКО АДМИН)
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
// КОМАНДА /pdf30 — простой PDF за 30 дней
// ======================================================

bot.command("pdf30", async ctx => {
  if (ctx.from.id !== OWNER_ID) {
    return ctx.reply("❌ У вас нет прав на просмотр отчёта.");
  }

  try {
    ctx.reply("⏳ Готовлю простой PDF-отчёт за последние 30 дней…");

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
// РАСШИРЕННЫЙ ОТЧЁТ: ХЕЛПЕР buildFullReport30Days
// ======================================================

async function buildFullReport30Days(filePath) {
  return new Promise(async (resolve, reject) => {
    try {
      const now = Date.now();
      const since = now - 30 * 24 * 60 * 60 * 1000;

      // Запросы к Firestore
      const [usersSnap, progressSnap, mistakesSnap] = await Promise.all([
        db.collection("users").get(),
        db.collection("progress").where("ts", ">", since).get(),
        db.collection("mistakes").where("ts", ">", since).get()
      ]);

      // Подготовка данных
      const users = [];
      let totalCorrectAll = 0;
      let totalWrongAll = 0;
      let sumLessons = 0;

      usersSnap.forEach(doc => {
        const u = doc.data();
        users.push({
          id: doc.id,
          name: u.name || "Без имени",
          points: u.points || 0,
          correctCount: u.correctCount || 0,
          wrongCount: u.wrongCount || 0,
          currentLesson: u.currentLesson || 0,
          lastLessonAt: u.lastLessonAt || null
        });
        totalCorrectAll += u.correctCount || 0;
        totalWrongAll += u.wrongCount || 0;
        sumLessons += u.currentLesson || 0;
      });

      const usersCount = users.length;
      const totalAnswersAll = totalCorrectAll + totalWrongAll;
      const accuracyAll = totalAnswersAll === 0 ? 0 : Math.round((totalCorrectAll / totalAnswersAll) * 100);
      const avgLessons = usersCount === 0 ? 0 : (sumLessons / usersCount).toFixed(1);

      // Активность за 30 дней
      const activity = new Array(30).fill(0);
      let totalOK30 = 0;
      let totalFAIL30 = 0;
      const activeUserIds = new Set();

      progressSnap.forEach(p => {
        const d = p.data();
        const ts = d.ts || 0;
        const dayIndex = Math.floor((ts - since) / (24 * 60 * 60 * 1000));
        if (dayIndex >= 0 && dayIndex < 30) {
          activity[dayIndex]++;
        }
        if (d.result === "OK") totalOK30++;
        else totalFAIL30++;
        if (d.userId) activeUserIds.add(String(d.userId));
      });

      const total30 = totalOK30 + totalFAIL30;
      const accuracy30 = total30 === 0 ? 0 : Math.round((totalOK30 / total30) * 100);
      const activeUsersCount = activeUserIds.size;

      // ТОП-10 по баллам
      const topByPoints = [...users]
        .sort((a, b) => (b.points || 0) - (a.points || 0))
        .slice(0, 10);

      // Анти-рейтинг по ошибкам (за 30 дней)
      const errorByUser = {};
      mistakesSnap.forEach(m => {
        const data = m.data();
        const uid = String(data.userId);
        errorByUser[uid] = (errorByUser[uid] || 0) + 1;
      });

      const antiTop = Object.entries(errorByUser)
        .map(([uid, errCount]) => {
          const u = users.find(x => String(x.id) === uid);
          return {
            uid,
            name: u?.name || uid,
            errors: errCount,
            points: u?.points || 0
          };
        })
        .sort((a, b) => b.errors - a.errors)
        .slice(0, 10);

      // Популярные ошибки (по вопросам)
      const mistakesAgg = {};
      mistakesSnap.forEach(doc => {
        const m = doc.data();
        const key = `${m.lesson}|||${m.question}|||${m.correctAnswer}`;
        if (!mistakesAgg[key]) {
          mistakesAgg[key] = {
            lesson: m.lesson,
            question: m.question,
            correctAnswer: m.correctAnswer,
            count: 0,
            wrongVariants: {}
          };
        }
        mistakesAgg[key].count++;
        if (m.userAnswer) {
          mistakesAgg[key].wrongVariants[m.userAnswer] =
            (mistakesAgg[key].wrongVariants[m.userAnswer] || 0) + 1;
        }
      });

      const popularMistakes = Object.values(mistakesAgg)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      // ====== Рисуем PDF ======
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Шрифт: пробуем кастомный, иначе Helvetica
      const fontPath = path.join(__dirname, 'fonts', 'Roboto-Regular.ttf');
      if (fs.existsSync(fontPath)) {
        doc.font(fontPath);
      } else {
        doc.font('Helvetica');
      }

      // Обложка
      doc.fontSize(24).text("Technocolor Academy", { align: "center" });
      doc.moveDown();
      doc.fontSize(18).text("Расширенный отчёт за последние 30 дней", { align: "center" });
      doc.moveDown(2);
      doc.fontSize(12).text(`Дата формирования: ${new Date().toLocaleString("ru-RU")}`);
      doc.text(`Всего пользователей в системе: ${usersCount}`);
      doc.moveDown(3);
      doc.fontSize(10).text("Отчёт сформирован автоматически системой Technocolor Academy.", { align: "left" });

      doc.addPage();

      // Блок 1 — Общая статистика
      doc.fontSize(18).text("1. Общая статистика за 30 дней", { underline: true });
      doc.moveDown();

      doc.fontSize(12);
      doc.text(`Всего пользователей: ${usersCount}`);
      doc.text(`Активных за 30 дней (давали ответы): ${activeUsersCount}`);
      doc.text(`Среднее количество пройденных уроков на пользователя: ${avgLessons}`);
      doc.moveDown();

      doc.text(`Всего ответов за 30 дней: ${total30}`);
      doc.text(`Правильных за 30 дней: ${totalOK30}`);
      doc.text(`Ошибок за 30 дней: ${totalFAIL30}`);
      doc.text(`Точность за 30 дней: ${accuracy30}%`);
      doc.moveDown();

      doc.text(`Всего правильных за всё время: ${totalCorrectAll}`);
      doc.text(`Всего ошибок за всё время: ${totalWrongAll}`);
      doc.text(`Общая точность за всё время: ${accuracyAll}%`);
      doc.moveDown(2);

      // Прогресс-бар точности за 30 дней
      ensureSpace(doc, 60);
      const barX = doc.x;
      const barY = doc.y + 10;
      const barW = 400;
      const barH = 14;

      doc.fontSize(12).text("Точность ответов за 30 дней:", { continued: false });
      doc.moveDown(0.5);

      doc.rect(barX, barY, barW, barH).stroke();
      const correctWidth = barW * (accuracy30 / 100);
      doc.save();
      doc.rect(barX, barY, correctWidth, barH).fill('#4caf50');
      doc.restore();
      doc.moveDown(2);
      doc.text(`Зелёная часть — доля правильных ответов (${accuracy30}%).`);
      doc.moveDown(2);

      // График активности по дням
      ensureSpace(doc, 160);
      doc.fontSize(16).text("2. Активность по дням (30 дней)", { underline: true });
      doc.moveDown();

      const chartX = doc.x;
      const chartY = doc.y + 10;
      const chartW = 450;
      const chartH = 120;

      // рамка
      doc.rect(chartX, chartY, chartW, chartH).stroke();

      const maxVal = Math.max(...activity) || 1;
      const stepX = chartW / (activity.length - 1 || 1);

      doc.moveTo(chartX, chartY + chartH);
      activity.forEach((v, i) => {
        const x = chartX + i * stepX;
        const y = chartY + chartH - (v / maxVal) * chartH;
        if (i === 0) doc.moveTo(x, y);
        else doc.lineTo(x, y);
      });
      doc.stroke();

      doc.fontSize(10).text(
        "Слева — 30 дней назад, справа — сегодня. По вертикали — количество ответов.",
        chartX,
        chartY + chartH + 10
      );

      doc.addPage();

      // ТОП-10 по баллам
      doc.fontSize(18).text("3. ТОП-10 участников по баллам", { underline: true });
      doc.moveDown();

      doc.fontSize(11);
      if (topByPoints.length === 0) {
        doc.text("Данных пока нет.");
      } else {
        topByPoints.forEach((u, i) => {
          ensureSpace(doc, 30);
          const totalAnswersU = (u.correctCount || 0) + (u.wrongCount || 0);
          const accU = totalAnswersU === 0 ? 0 : Math.round((u.correctCount / totalAnswersU) * 100);
          doc.text(
            `${i + 1}) ${u.name} — баллы: ${u.points}, пройдено уроков: ${u.currentLesson}, точность: ${accU}%`
          );
        });
      }

      doc.addPage();

      // Анти-рейтинг по ошибкам
      doc.fontSize(18).text("4. Анти-рейтинг по ошибкам (за 30 дней)", { underline: true });
      doc.moveDown();

      doc.fontSize(11);
      if (antiTop.length === 0) {
        doc.text("За последние 30 дней ошибок не зафиксировано — это отлично.");
      } else {
        antiTop.forEach((u, i) => {
          ensureSpace(doc, 30);
          doc.text(
            `${i + 1}) ${u.name} — ошибок за 30 дней: ${u.errors}, баллы: ${u.points}`
          );
        });
      }

      doc.addPage();

      // Популярные ошибки
      doc.fontSize(18).text("5. Самые частые ошибки по вопросам", { underline: true });
      doc.moveDown();

      if (popularMistakes.length === 0) {
        doc.fontSize(11).text("За последние 30 дней не найдено повторяющихся ошибок.");
      } else {
        popularMistakes.forEach((m, i) => {
          ensureSpace(doc, 80);
          doc.fontSize(12).text(`${i + 1}) Урок ${m.lesson}`, { continued: false });
          doc.fontSize(11).text(`Вопрос: ${m.question}`);
          doc.text(`Ошибок за 30 дней: ${m.count}`);
          const wrongList = Object.entries(m.wrongVariants)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 2);
          if (wrongList.length > 0) {
            const topWrong = wrongList
              .map(([val, cnt]) => `"${val}" — ${cnt} раз(а)`)
              .join("; ");
            doc.text(`Чаще всего отвечают: ${topWrong}`);
          }
          doc.text(`Правильный ответ: ${m.correctAnswer}`);
          doc.moveDown();
        });
      }

      doc.addPage();

      // Итог
      doc.fontSize(18).text("6. Выводы и рекомендации", { underline: true });
      doc.moveDown();

      doc.fontSize(12).text(
        `Точность ответов за последние 30 дней составила ${accuracy30}%.`
      );
      if (popularMistakes.length > 0) {
        const hardestLesson = popularMistakes[0].lesson;
        doc.text(
          `Наибольшее число ошибок приходится на вопросы урока №${hardestLesson}. Рекомендуется усилить обучение по этой теме и сделать дополнительные разборы.`
        );
      }
      doc.moveDown();
      doc.text(
        "Рекомендуется ежемесячно анализировать динамику, просматривать анти-рейтинг и точечные ошибки, а также поощрять участников из ТОП-10 по баллам."
      );
      doc.moveDown(2);
      doc.fontSize(10).text("Technocolor Academy • Автоматический отчёт", { align: "right" });

      doc.end();

      stream.on("finish", () => resolve());
      stream.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

// ======================================================
// КОМАНДА /pdf_full — расширенная аналитика за 30 дней (ТОЛЬКО АДМИН)
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
// ТЕКСТ (регистрация: только имя)
// ======================================================

bot.on("text", async ctx => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  // ввод имени
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
// ПОЛУЧЕНИЕ КОНТАКТА (ТЕЛЕФОНА) — БЕЗ СМС, СРАЗУ РЕГИСТРАЦИЯ
// ======================================================

// ======================================================
// ПОЛУЧЕНИЕ КОНТАКТА (ТЕЛЕФОНА) — БЕЗ СМС, С МЕНЮ
// ======================================================

bot.on("contact", async ctx => {
  const userId = ctx.from.id;

  if (tempUsers[userId]?.step !== "phone") return;

  const phone = ctx.message.contact.phone_number;
  const tmp = tempUsers[userId] || {};
  const name = tmp.name || ctx.from.first_name || "Без имени";

  // СОХРАНЯЕМ ПОЛНОСТЬЮ ГОТОВОГО ПОЛЬЗОВАТЕЛЯ
  const userState = {
    name,
    phone,
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

  // 🔥 СКРЫВАЕМ КНОПКУ "ОТПРАВИТЬ НОМЕР"
  await ctx.reply("Номер сохранён ✅", {
    reply_markup: { remove_keyboard: true }
  });

  // 🔥 ВОЗВРАЩАЕМ ОСНОВНОЕ МЕНЮ
  await ctx.reply("Меню:", Markup.keyboard([
    ["▶️ Старт"],
    ["Итог ⭐", "Рейтинг 🏆"]
  ]).resize());

  // 🔥 ПРЕДЛАГАЕМ ВЫБОР РОЛИ
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
    u.nextLessonAt = Date.now() + 24 * 60 * 60 * 1000;
    await ctx.reply("✅ Правильно! Следующий урок — через 24 часа.");
    await logProgress(userId, u, "OK");
  } else {
    u.streak = 0;
    if (u.points && u.points > 0) u.points--;
    u.wrongCount = (u.wrongCount || 0) + 1;

    u.nextLessonAt = Date.now() + 30 * 60 * 1000;
    await ctx.reply("❌ Ошибка. Балл снят. Через 30 минут попробуешь снова.");
    await logProgress(userId, u, "FAIL");
    await logMistake(userId, u.currentLesson, lesson, answer);
  }

  await saveUser(userId, u);
});

bot.action("check_time", async ctx => {
    const userId = ctx.from.id;
    const u = await getUser(userId);

    if (!u.nextLessonAt) {
        return ctx.reply("👍 Ты можешь проходить урок прямо сейчас!");
    }

    const now = Date.now();
    const diff = u.nextLessonAt - now;

    if (diff <= 0) {
        return ctx.reply("🔥 Время пришло! Можешь проходить следующий урок.");
    }

    // переводим в часы/минуты
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    let message = "⏳ До следующего урока осталось:\n";

    if (hours > 0) message += `• ${hours} ч\n`;
    message += `• ${minutes} мин`;

    await ctx.reply(message);
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