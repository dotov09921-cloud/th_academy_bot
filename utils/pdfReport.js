const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

async function generate30DaysPDF(data) {
  const reportsDir = path.join(__dirname, "../reports");
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }

  const pdfPath = path.join(reportsDir, "report_30days.pdf");

  // путь к локальному шрифту
  const fontPath = path.join(__dirname, "../fonts/Roboto-Regular.ttf");

  if (!fs.existsSync(fontPath)) {
    throw new Error("❌ Шрифт не найден: " + fontPath);
  }

  // создаем PDF
  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(pdfPath);
  doc.pipe(stream);

  doc.registerFont("Roboto", fontPath);

  // Заголовок
  doc.font("Roboto").fontSize(24).text("Отчёт Technocolor Academy", {
    align: "center",
  });

  doc.moveDown();
  doc.fontSize(14);

  doc.text(`Активных пользователей (30 дней): ${data.activeUsers}`);
  doc.text(`Правильных ответов: ${data.totalCorrect}`);
  doc.text(`Неправильных: ${data.totalWrong}`);
  doc.text(`Точность: ${data.percent}%`);

  doc.moveDown();
  doc.fontSize(13).text("Дополнительная статистика:");
  data.extra.forEach((l) => doc.text("• " + l));

  doc.end();

  return new Promise((resolve) => {
    stream.on("finish", () => resolve(pdfPath));
  });
}

module.exports = { generate30DaysPDF };