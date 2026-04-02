const pdfParse = require('pdf-parse');

async function parsePDF(buffer) {
  const data = await pdfParse(buffer);
  const text = data.text;

  // Basic line-by-line extraction — looks for date + description + amount patterns
  const lines = text.split('\n').filter(l => l.trim());
  const transactions = [];
  const datePattern = /(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/;
  const amountPattern = /(-?\$?[\d,]+\.\d{2})/;

  for (const line of lines) {
    const dateMatch = line.match(datePattern);
    const amountMatch = line.match(amountPattern);

    if (dateMatch && amountMatch) {
      const amount = Number(amountMatch[1].replace(/[$,]/g, ''));
      const description = line
        .replace(dateMatch[0], '')
        .replace(amountMatch[0], '')
        .trim();

      if (description.length > 2) {
        transactions.push({
          date: dateMatch[1],
          description,
          amount,
          type: amount < 0 ? 'debit' : 'credit',
        });
      }
    }
  }

  return transactions;
}

module.exports = { parsePDF };
