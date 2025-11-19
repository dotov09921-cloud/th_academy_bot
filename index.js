require('dotenv').config();
const { Telegraf } = require('telegraf');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  throw new Error('Не указан BOT_TOKEN в .env');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ===================================================================
// ===  ЭТАП 2. РЕГИСТРАЦИЯ ПОЛЬЗОВАТЕЛЯ  ==============================
// ===================================================================

// Временное хранилище для регистрации (позже заменим на БД/Google Sheets)
const tempUsers = {};

// Основное хранилище прогресса (позже вынесем в Google Sheets/БД)
const users = {};

// Уроки (позже сюда будет 90 уроков)
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

// ===== /start → начало регистрации =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // ставим пользователя в режим регистрации
  tempUsers[userId] = { step: 'ask_name' };

  await ctx.reply('Привет! Введи своё имя для регистрации:');
});

// ===================================================================
// ===  ЭТАП 3. РЕГИСТРАЦИЯ + ПРОГРЕСС + ОТВЕТЫ НА УРОКИ ==============
// ===================================================================

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const msgRaw = ctx.message.text || '';
  const msg = msgRaw.trim();

  // 1) Если пользователь в процессе регистрации → обрабатываем регистрацию
  if (tempUsers[userId]?.step === 'ask_name') {
    const name = msg;

    console.log(`Регистрация → ${userId} | Имя: ${name}`);

    // создаём запись прогресса
    users[userId] = {
      name,
      currentLesson: 1,
      waitingAnswer: false,
      nextLessonAt: 0,
      lastLessonAt: 0,
      points: 0,
    };

    // выходим из режима регистрации
    delete tempUsers[userId];

    await ctx.reply(`Отлично, ${name}! Регистрация завершена ✅`);
    await sendLesson(ctx, 1);
    return;
  }

  // 2) Если пользователь НЕ зарегистрирован и не регистрируется — игнорим
  if (!users[userId]) {
    return;
  }

  // 3) Если сейчас НЕ ждём его ответа на урок → игнорим (антиспам)
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
    return;
  }

  const answerUser = msg.toLowerCase();
  const answerCorrect = lesson.answer.toLowerCase();

  // ===== Правильный ответ ===========================================
  if (answerUser === answerCorrect) {
    userState.waitingAnswer = false;
    userState.points += 1;

    await ctx.reply('✅ Правильно! Балл начислён. Следующий урок придёт через 24 часа.');

    // следующий урок через 24 часа
    userState.nextLessonAt = Date.now() + 24 * 60 * 60 * 1000;
    userState.currentLesson += 1;

    console.log(
      `USER ${userId} (${userState.name}) | lesson ${currentLesson} OK | points=${userState.points}`,
    );

    // здесь позже добавим реальную отправку по таймеру
    return;
  }

  // ===== Неправильный ответ =========================================
  userState.waitingAnswer = false;
  userState.nextLessonAt = Date.now() + 30 * 60 * 1000; // повтор через 30 минут

  await ctx.reply('❌ Неправильно. Тот же урок придёт снова через 30 минут.');

  console.log(
    `USER ${userId} (${userState.name}) | lesson ${currentLesson} FAIL | points=${userState.points}`,
  );
});

// -------------------------------------------------------------------
// === ФУНКЦИЯ ОТПРАВКИ УРОКА ========================================
// -------------------------------------------------------------------
async function sendLesson(ctx, lessonNumber) {
  const userId = ctx.from.id;

  if (!users[userId]) {
    return;
  }

  const lesson = lessons[lessonNumber];

  if (!lesson) {
    await ctx.reply('🎉 Уроки закончились. Скоро добавим новые.');
    return;
  }

  users[userId].waitingAnswer = true;
  users[userId].lastLessonAt = Date.now();
  users[userId].nextLessonAt = 0; // будет выставлен после ответа

  await ctx.reply(`Урок №${lessonNumber}\n\n${lesson.text}\n\nНапиши ответ:`);

  console.log(
    `SEND LESSON ${lessonNumber} → user ${userId} (${users[userId].name})`,
  );
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

  // подключаем webhook
  bot.telegram.setWebhook(WEBHOOK_URL);
  app.use(bot.webhookCallback(path));

  // проверка работы сервера
  app.get('/', (req, res) => res.send('Bot is running'));

  app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`Webhook path: ${WEBHOOK_URL}`);
  });
} else {
  console.log('WEBHOOK_URL отсутствует → запускаю polling');
  bot.launch();
}

// ===== Корректное завершение =====
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
