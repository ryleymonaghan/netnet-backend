const Papa = require('papaparse');

function parseCSV(buffer) {
  const text = buffer.toString('utf-8');
  const result = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: true,
  });

  return result.data.map(row => {
    // Normalize common bank CSV column names
    const date = row.Date || row.date || row['Transaction Date'] || row['Post Date'] || '';
    const description = row.Description || row.description || row.Memo || row.memo || '';
    const amount = row.Amount || row.amount || 0;
    const debit = row.Debit || row.debit || 0;
    const credit = row.Credit || row.credit || 0;

    // If separate debit/credit columns, combine (debit as negative)
    const finalAmount = amount || (credit ? Number(credit) : -Math.abs(Number(debit)));

    return {
      date,
      description: String(description).trim(),
      amount: Number(finalAmount) || 0,
      type: finalAmount < 0 ? 'debit' : 'credit',
    };
  }).filter(tx => tx.description && tx.date);
}

module.exports = { parseCSV };
