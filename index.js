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

// временное хранилище для регистрации
const tempUsers = {};

// /start — начало регистрации
bot.start(async (ctx) => {
  const userId = ctx.from.id;

  tempUsers[userId] = { step: "ask_name" };

  await ctx.reply("Привет! Введи своё имя для регистрации:");
});

// обработка текстовых сообщений во время регистрации
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const msg = ctx.message.text;

  if (!tempUsers[userId]) return; // человек не в процессе регистрации

  if (tempUsers[userId].step === "ask_name") {
    const name = msg.trim();

    // здесь позже добавим Google Sheets или БД
    console.log(`Регистрация → ${userId} | Имя: ${name}`);

    // очищаем состояние
    delete tempUsers[userId];

    await ctx.reply(`Отлично, ${name}! Регистрация завершена.`);

    // отправляем первый урок
    await sendLesson(ctx, 1);
  }
});

// Функция отправки урока
async function sendLesson(ctx, lessonNumber) {
  await ctx.reply(`Урок №${lessonNumber}\n\nТекст урока будет здесь.`);
}
// ===================================================================


// ===== ЛОГИКА БОТА (тестовые команды) =====
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
  console.log('WEBHOOK_URL отсутствует → запускаю polling');
  bot.launch();
}

// ===== Корректное завершение =====
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
