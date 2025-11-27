const PDFDocument = require('pdfkit');
const fs = require('fs');

function createPDF(path, stats) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ margin: 40 });

    doc.pipe(fs.createWriteStream(path));

    // HEADER
    doc
      .fontSize(22)
      .fillColor('#333')
      .text('Technocolor Academy', { align: 'center' });

    doc.moveDown(0.5);

    doc
      .fontSize(14)
      .fillColor('#666')
      .text('Аналитический отчёт за 30 дней', { align: 'center' });

    doc.moveDown(1.5);

    // Блок общей статистики
    doc
      .fontSize(18)
      .fillColor('#000')
      .text('Общая статистика', { underline: true });

    doc.moveDown(0.5);

    doc.fontSize(12).fillColor('#000');
    doc.text(`Правильных ответов: ${stats.totalCorrect}`);
    doc.text(`Ошибок: ${stats.totalWrong}`);
    doc.text(`Всего ответов: ${stats.totalAnswers}`);
    doc.text(`Средняя точность: ${stats.percent}%`);

    doc.moveDown(1);

    // Топ пользователей
    doc.fontSize(18).text('ТОП-10 активных пользователей', { underline: true });
    doc.moveDown(0.7);

    stats.topUsers.forEach((u, i) => {
      doc.fontSize(12).text(`${i + 1}) ${u.name} — ${u.total} действий (${u.ok}✓ / ${u.fail}✗)`);
    });

    doc.moveDown(1);

    // Ошибки
    doc.fontSize(18).text('ТОП уроков по ошибкам', { underline: true });
    doc.moveDown(0.7);

    stats.errors.forEach(e => {
      doc.fontSize(12).text(`Урок ${e.lesson} — ${e.count} ошибок`);
    });

    doc.end();

    resolve(path);
  });
}

module.exports = { createPDF };