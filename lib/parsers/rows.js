// Step 3 of the SC Federal parser rebuild (NETNET_PARSER_SPEC.md): parse
// individual transaction rows within each account section and validate
// every one against the running balance.
//
// CORE RULE (do not weaken this): the debit/credit columns collapse into
// ambiguous whitespace during text extraction, so we never infer sign from
// column position. We infer it from the running balance instead — the
// delta between this row's balance and the prior row's balance is the
// signed amount. If the statement's own printed amount doesn't match that
// delta within 2 cents, the row is flagged UNRECONCILED and excluded from
// downstream totals rather than guessed.
//
// A transaction spans a variable number of lines depending on variant:
//   - Variant A: the date line itself carries both amounts (transaction +
//     balance). Any plain-text lines below it are additional description,
//     not more transactions, until the next date line.
//   - Variant B: the date line usually carries zero amounts; description
//     wraps across one or more plain-text lines, and the two amounts land
//     on the last line of the block. (Short-description B rows sometimes
//     fit on one line and look identical to variant A — that's fine, the
//     same logic closes them immediately.)
// Both shapes reduce to the same rule: a block closes the moment a line
// carries two or more inline amounts; every line before that (including the
// date line) is description.
const { ACCOUNTS, RE_HEADER, RE_BEGIN, RE_END, RE_MONEY, money } = require('./accounts');

const RE_DATE_LINE = /^(\d{2}\/\d{2}\/\d{4})\b(.*)$/;
const RECONCILE_TOLERANCE = 0.02;

// The loan (6621) prints no per-row running balance at all — each payment is
// "<effective date> <posting date> Regular Payment $<amount>" followed by
// separate "Principal $<x>" / "Interest $<y>" lines. There's nothing to take
// a balance delta against, so it's reconciled on principal + interest ==
// payment instead.
const RE_LOAN_PAYMENT = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(-?\$[\d,]+\.\d{2})$/;
// Legacy (variant A) statements print these with a trailing colon
// ("Principal: $673.94"); current (variant B) statements don't
// ("Principal $671.00"). Both accepted.
const RE_LOAN_PRINCIPAL = /^Principal:?\s+(-?\$[\d,]+\.\d{2})$/i;
const RE_LOAN_INTEREST = /^Interest:?\s+(-?\$[\d,]+\.\d{2})$/i;

// Fee/analysis/disclosure boilerplate that follows the real transaction
// table for each account. It can contain dates (check-cleared listings) and
// dollar amounts (fee schedules) that are not transactions.
const RE_ACTIVITY_START = /^Account Activity/i;
const RE_ACTIVITY_END = /^Account Analysis|^Checks? Cleared|^Statement Year to Date/i;

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
  /^Effective Date\s+Posting Date\s+Description\s+Amount$/i,
  /^Date\s+Description\s+Amount$/i,
  /^Post Date\s+Description\s+Debits\s+Credits\s+Balance$/i,
];
const FOOTER = [
  /Statement Ending \d{2}\/\d{2}\/\d{4}/,
  /Page \d+ of \d+/,
  /^[A-F0-9]{24,}/,
  /Savings Account Statements/,
  /Member Number/,
];
const isNoise = l => NOISE.some(r => r.test(l)) || FOOTER.some(r => r.test(l));

const round2 = n => Math.round(n * 100) / 100;
const stripMoney = s => s.replace(RE_MONEY, '').replace(/\s+/g, ' ').trim();

function parseStatement(rawText) {
  const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean);

  const sections = new Map();  // account number -> section record
  let current = null;
  let inActivity = false;
  let lastTx = null;  // in-progress or most-recently-closed transaction

  const flushIncomplete = () => {
    if (lastTx && !lastTx.resolved) {
      lastTx.flag = 'UNRECONCILED';
      lastTx.note = 'Block never closed with a two-amount line (missing balance).';
      current.transactions.push(lastTx);
    }
    lastTx = null;
  };

  const seedOrCloseBalance = (label, amounts) => {
    const v = money(amounts[amounts.length - 1]);
    if (RE_BEGIN.test(label)) {
      if (current.beginningBalance === null) current.beginningBalance = v;
      if (current.runningBalance === null) current.runningBalance = v;
    } else if (RE_END.test(label)) {
      current.endingBalance = v;
    }
  };

  const closeTransaction = (tx, printed, newBalance) => {
    tx.description = tx.description || '(no description)';
    if (current.runningBalance === null) {
      // No Beginning Balance seen yet — can't compute a delta. Record what
      // we saw, flag it, and seed the chain from here so later rows can
      // still be validated.
      tx.amount = null;
      tx.balance_after = newBalance;
      tx.printed_amount = printed;
      tx.flag = 'UNRECONCILED';
      tx.note = 'No beginning balance seen before this row.';
      current.runningBalance = newBalance;
    } else {
      const delta = round2(newBalance - current.runningBalance);
      const reconciled = Math.abs(Math.abs(delta) - printed) <= RECONCILE_TOLERANCE;
      tx.amount = delta;
      tx.type = delta < 0 ? 'debit' : delta > 0 ? 'credit' : 'zero';
      tx.balance_after = newBalance;
      tx.printed_amount = printed;
      tx.flag = reconciled ? 'OK' : 'UNRECONCILED';
      if (!reconciled) {
        tx.note = `Statement printed ${printed.toFixed(2)} but the balance moved ${delta.toFixed(2)}.`;
      }
      current.runningBalance = newBalance;
    }
    tx.resolved = true;
    current.transactions.push(tx);
  };

  for (const line of lines) {
    const headerMatch = line.match(RE_HEADER);
    if (headerMatch) {
      const acct = ACCOUNTS[headerMatch[1]];
      const isNewAccount = !current || current.number !== acct.number;
      // A "(continued)" header for the SAME account, right after a page
      // break, must not disturb in-flight state — the transaction whose
      // amount landed on the previous page can still have its continuation
      // description line arriving on this one (see rows.js module comment).
      // Only a genuine account switch resets inActivity/lastTx.
      if (isNewAccount) {
        flushIncomplete();
        inActivity = false;
      }
      if (!sections.has(acct.number)) {
        sections.set(acct.number, {
          name: headerMatch[1],
          number: acct.number,
          kind: acct.kind,
          beginningBalance: null,
          endingBalance: null,
          runningBalance: null,
          transactions: [],
        });
      }
      current = sections.get(acct.number);
      continue;
    }

    if (!current) continue;

    if (RE_ACTIVITY_START.test(line)) { inActivity = true; continue; }
    if (RE_ACTIVITY_END.test(line)) { inActivity = false; flushIncomplete(); continue; }

    if (current.kind === 'loan' && inActivity) {
      const payMatch = line.match(RE_LOAN_PAYMENT);
      if (payMatch) {
        flushIncomplete();
        lastTx = {
          date: payMatch[2],
          description: payMatch[3].trim(),
          amount: money(payMatch[4]),
          principal: null,
          interest: null,
          resolved: false,
        };
        continue;
      }
      const principalMatch = line.match(RE_LOAN_PRINCIPAL);
      if (principalMatch && lastTx && !lastTx.resolved) {
        lastTx.principal = money(principalMatch[1]);
        continue;
      }
      const interestMatch = line.match(RE_LOAN_INTEREST);
      if (interestMatch && lastTx && !lastTx.resolved) {
        lastTx.interest = money(interestMatch[1]);
        const expected = round2((lastTx.principal || 0) + lastTx.interest);
        const reconciled = Math.abs(expected - lastTx.amount) <= RECONCILE_TOLERANCE;
        lastTx.type = 'payment';
        lastTx.flag = reconciled ? 'OK' : 'UNRECONCILED';
        if (!reconciled) {
          lastTx.note = `Principal (${lastTx.principal}) + Interest (${lastTx.interest}) = ${expected}, but payment was ${lastTx.amount}.`;
        }
        lastTx.resolved = true;
        current.transactions.push(lastTx);
        continue;
      }
    }

    const dateMatch = line.match(RE_DATE_LINE);

    if (dateMatch) {
      const rest = dateMatch[2] || '';
      const amounts = rest.match(RE_MONEY) || [];

      if (RE_BEGIN.test(rest) || RE_END.test(rest)) {
        if (amounts.length) seedOrCloseBalance(rest, amounts);
        continue;
      }

      if (!inActivity) continue;

      flushIncomplete();
      lastTx = { date: dateMatch[1], description: stripMoney(rest), resolved: false };
      if (amounts.length >= 2) {
        closeTransaction(lastTx, Math.abs(money(amounts[amounts.length - 2])), money(amounts[amounts.length - 1]));
      }
      continue;
    }

    if (!inActivity) continue;
    if (isNoise(line)) continue;

    const amounts = line.match(RE_MONEY) || [];

    if (amounts.length >= 2 && lastTx && !lastTx.resolved) {
      const lead = stripMoney(line);
      if (lead) lastTx.description = `${lastTx.description} ${lead}`.trim();
      closeTransaction(lastTx, Math.abs(money(amounts[amounts.length - 2])), money(amounts[amounts.length - 1]));
      continue;
    }

    if (amounts.length === 0 && lastTx) {
      lastTx.description = `${lastTx.description} ${line}`.trim();
      continue;
    }

    // Exactly one inline amount on a continuation line, or a 2+-amount line
    // with no open block to close — genuinely ambiguous. Fold it into the
    // description rather than guessing which number means what.
    if (lastTx && !lastTx.resolved) {
      lastTx.description = `${lastTx.description} ${line}`.trim();
    }
  }

  flushIncomplete();

  return [...sections.values()].map(s => {
    const resolved = s.transactions.filter(t => t.resolved);
    const reconciledCount = resolved.filter(t => t.flag === 'OK').length;
    return {
      ...s,
      reconciledCount,
      totalCount: resolved.length,
      reconciledPct: resolved.length ? round2((reconciledCount / resolved.length) * 100) : null,
    };
  });
}

module.exports = { parseStatement };
