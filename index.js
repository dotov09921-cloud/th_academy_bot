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

// ===== /start → начало регистрации =====
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  // состояние регистрации
  tempUsers[userId] = { step: "ask_name" };

  await ctx.reply("Привет! Введи своё имя для регистрации:");
});

// ===== обработка имени =====
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text;

  // если человек НЕ в процессе регистрации — пропускаем
  if (!tempUsers[userId]) return;

  // если ждём имя
  if (tempUsers[userId].step === "ask_name") {
    const name = msg.trim();

    console.log(`Регистрация → ${userId} | Имя: ${name}`);

    // очищаем временное состояние
    delete tempUsers[userId];

    await ctx.reply(`Отлично, ${name}! Регистрация завершена.`);

    // отправляем первый урок
    await sendLesson(ctx, 1);
  }
});

// -------------------------------------------------------------------
// === ФУНКЦИЯ ОТПРАВКИ УРОКА ========================================
// -------------------------------------------------------------------
async function sendLesson(ctx, lessonNumber) {
  await ctx.reply(`Урок №${lessonNumber}\n\nТекст урока будет здесь.`);
}
// ===================================================================


// ===== Доп. команда для теста =====
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
