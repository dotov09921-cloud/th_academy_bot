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

// --------- ЛОГИКА БОТА ---------
bot.start((ctx) => {
  ctx.reply('Привет! Бот запущен и работает через Render ✅');
});

bot.hears('тест', (ctx) => {
  ctx.reply('Бот живой, всё отлично 💪');
});

// --------- НАСТРОЙКА WEBHOOK ---------
if (WEBHOOK_URL) {
  // путь, по которому будет принимать запросы наш сервер
  const path = '/telegram-webhook';

  bot.telegram.setWebhook(WEBHOOK_URL);

  app.use(bot.webhookCallback(path));

  app.get('/', (req, res) => {
    res.send('Bot is running');
  });

  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}`);
  });
} else {
  // Режим polling — только для локальных тестов
  console.log('WEBHOOK_URL не указан. Запускаю bot.launch() (long polling)...');
  bot.launch();
}

// Чтобы бот аккуратно завершался
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
