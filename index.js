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
bot.start((ctx) => ctx.reply('Привет! Бот запущен через Render ✅'));
bot.hears('тест', (ctx) => ctx.reply('Бот живой 💪'));

// --------- WEBHOOK ---------
const path = '/telegram-webhook';

if (WEBHOOK_URL) {
  bot.telegram.setWebhook(`${WEBHOOK_URL}${path}`);

  app.use(path, bot.webhookCallback(path));

  app.get('/', (req, res) => res.send('Bot is running'));
} else {
  console.log('WEBHOOK_URL не указан. Запускаю long polling...');
  bot.launch();
}

// --------- СТАРТ СЕРВЕРА ---------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Webhook URL: ${WEBHOOK_URL}${path}`);
});

// --------- GRACEFUL SHUTDOWN ---------
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
