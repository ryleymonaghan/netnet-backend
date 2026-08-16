// pdf-parse v1 exports a function; v2 exports a PDFParse class with a totally
// different API. Railway resolved v2 while the lockfile said v1, which threw
// "pdfParse is not a function" in production. Rather than depend on which
// version wins a fresh install, detect the shape at require time and adapt.
const pdfLib = require('pdf-parse');

async function extractText(buffer) {
  if (typeof pdfLib === 'function') {                 // v1
    const out = await pdfLib(buffer);
    return out.text || '';
  }
  if (pdfLib && typeof pdfLib.PDFParse === 'function') {   // v2
    const parser = new pdfLib.PDFParse({ data: buffer });
    try {
      const out = await parser.getText();
      return out.text || '';
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy();
    }
  }
  if (pdfLib && typeof pdfLib.default === 'function') {    // esm interop
    const out = await pdfLib.default(buffer);
    return out.text || '';
  }
  throw new Error('pdf-parse is installed in an unrecognized form; cannot read PDFs.');
}

// ── South Carolina Federal CU (and similar) multi-account statements ────────
//
// Text extraction destroys the Debits/Credits column split — a $300 debit and a
// $300 credit come out as identical strings. The ONLY reliable signal is the
// running balance, which every row carries. So we anchor on "Beginning Balance"
// and derive each amount as (newBalance - previousBalance). That also makes the
// parse self-verifying: if our final balance doesn't match the statement's
// stated Ending Balance, we know the parse drifted and say so instead of
// silently importing wrong numbers.
//
// A useful side effect: returned/NSF items (where the bank prints an amount but
// the balance never moves) come through as 0.00 and are flagged, which is what
// actually happened to the money.

const RE_ACCT_HEADER = /^([A-Z][A-Z0-9&.' ]*?)\s*-\s*(X+\d[-\d]*)\s*(?:\(continued\))?\s*$/;
const RE_ROW         = /^(\d{2}\/\d{2}\/\d{4})(.*)$/;
const RE_MONEY       = /-?\$[\d,]+\.\d{2}/g;

// Page furniture repeats mid-transaction and was leaking into descriptions.
// These match anywhere in the line, not just at the start.
const FOOTER = [
  /Statement Ending \d{2}\/\d{2}\/\d{4}/,
  /Page \d+ of \d+/,
  /^[A-F0-9]{24,}/,
  /Savings Account Statements/,
  /Member Number/,
];

const NOISE = [
  /^Post Date$/i, /^Description$/i, /^Debits\s*Credits\s*Balance$/i,
  /^Account Activity/i, /^Account Summary/i, /^Account Analysis/i,
  /^Checks? Cleared/i, /^Check Nbr/i, /^Date\s*Description\s*Amount$/i,
  /^Statement Ending/i, /^Member Number/i, /^Page \d+ of \d+$/i,
  /Statement EndingPage \d+/i, /Savings Account Statements$/i,
  /^\* Indicates skipped/i, /^Service Class/i, /^Average Daily Balance/i,
  /^Analysis Summary/i, /^Maintenance/i, /^Accumulated Fees/i,
  /^Activity Analysis/i, /^Service Analysis/i, /^Total$/i,
  /^This page left intentionally blank/i, /^Outstanding Items/i,
  /^\s*$/,
];

const money = s => Number(String(s).replace(/[$,]/g, ''));
const isNoise = l => NOISE.some(r => r.test(l.trim())) || FOOTER.some(r => r.test(l));

function toISO(mdy) {
  const [m, d, y] = mdy.split('/');
  return `${y}-${m}-${d}`;
}

async function parsePDF(buffer) {
  const text = await extractText(buffer);
  return extract(text);
}

function extract(text) {
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));

  const accounts = new Map();   // mask -> account record
  let cur = null;               // current account
  let inActivity = false;
  let last = null;              // last transaction, for description continuation

  const startAccount = (label, mask) => {
    const sameAccount = cur && cur.mask === mask;   // "(continued)" across a page
    if (!accounts.has(mask)) {
      accounts.set(mask, {
        label: label.trim(),
        mask,
        key: mask.replace(/\D/g, ''),      // "XXXXXX6-71" -> "671"
        transactions: [],
        beginningBalance: null,
        endingBalance: null,
        runningBalance: null,
      });
    }
    cur = accounts.get(mask);
    if (!sameAccount) { inActivity = false; last = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (FOOTER.some(r => r.test(line))) continue;

    const hdr = line.match(RE_ACCT_HEADER);
    if (hdr && !/^\d/.test(line)) { startAccount(hdr[1], hdr[2]); continue; }
    if (!cur) continue;

    if (/^Account Activity/i.test(line)) { inActivity = true; last = null; continue; }
    // Everything after the analysis block is fees and check listings, not activity.
    if (/^Account Analysis|^Checks? Cleared|^Statement Year to Date/i.test(line)) {
      inActivity = false; last = null; continue;
    }

    const row = line.match(RE_ROW);

    if (!row) {
      // Continuation line — merchant name printed under its transaction.
      if (inActivity && last && !isNoise(line) && !/^\$/.test(line)) {
        last.description = `${last.description} ${line}`.replace(/\s+/g, ' ').trim();
      }
      continue;
    }

    const rest = row[2] || '';
    const amounts = rest.match(RE_MONEY) || [];
    const label = rest.replace(RE_MONEY, '').trim();

    // Balance anchors appear in both the summary block and the activity table.
    if (/Beginning Balance/i.test(label) && amounts.length) {
      const v = money(amounts[amounts.length - 1]);
      if (cur.beginningBalance === null) cur.beginningBalance = v;
      cur.runningBalance = v;
      last = null;
      continue;
    }
    if (/Ending Balance/i.test(label) && amounts.length) {
      cur.endingBalance = money(amounts[amounts.length - 1]);
      last = null;
      continue;
    }

    if (!inActivity) { last = null; continue; }
    if (amounts.length < 2) { last = null; continue; }  // need amount + balance
    if (cur.runningBalance === null) { last = null; continue; }

    const newBalance = money(amounts[amounts.length - 1]);
    const printed    = Math.abs(money(amounts[amounts.length - 2]));
    const delta      = Number((newBalance - cur.runningBalance).toFixed(2));

    const tx = {
      date: toISO(row[1]),
      description: label || 'Transaction',
      amount: delta,
      type: delta < 0 ? 'debit' : 'credit',
      balance_after: newBalance,
      printed_amount: printed,
    };

    // Bank printed an amount but no money moved — returned item, NSF, or a
    // reversal. Keep it visible rather than importing a phantom expense.
    if (delta === 0 && printed > 0) {
      tx.flag = 'no_balance_change';
      tx.note = 'Bank listed an amount but the balance did not move (returned or reversed item).';
    } else if (Math.abs(Math.abs(delta) - printed) > 0.01) {
      tx.flag = 'amount_mismatch';
      tx.note = `Statement printed ${printed.toFixed(2)} but the balance moved ${delta.toFixed(2)}.`;
    }

    cur.runningBalance = newBalance;
    cur.transactions.push(tx);
    last = tx;
  }

  // Reconcile every account against its own stated ending balance.
  const result = [...accounts.values()].map(a => {
    const computed = a.transactions.reduce((s, t) => s + t.amount, a.beginningBalance ?? 0);
    const diff = a.endingBalance === null ? null
               : Number((a.endingBalance - computed).toFixed(2));
    return {
      label: a.label,
      mask: a.mask,
      key: a.key,
      beginning_balance: a.beginningBalance,
      ending_balance: a.endingBalance,
      computed_balance: Number(computed.toFixed(2)),
      difference: diff,
      balanced: diff !== null && Math.abs(diff) < 0.01,
      count: a.transactions.length,
      flagged: a.transactions.filter(t => t.flag).length,
      transactions: a.transactions,
    };
  }).filter(a => a.count > 0 || a.beginning_balance !== null);

  return result;
}

module.exports = { parsePDF, extract, extractText };
