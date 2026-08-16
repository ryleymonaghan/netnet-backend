// TRANSFER ELIMINATION (NETNET_PARSER_SPEC.md). ~40% of transaction volume
// is internal movement between the 4 deposit accounts and the loan. Left in
// the P&L, revenue and expenses are both overstated by six figures.
//
// The two statement variants describe these differently:
//   - Variant B (current): "TFR TO/FRM CHECKG x<acct>" and
//     "LOAN PYMT TO LOAN x6621", where <acct> is the real 4-digit account
//     number directly.
//   - Variant A (legacy): EVERY inter-account transfer, including
//     checking-to-checking, is worded "TFR TO/FROM SHARES #######<suffix>"
//     (loan: "TFR TO LOAN #######66-21") - it never says "CHECKG" at all.
//     <suffix> is a 2-digit-hyphen-2-digit legacy code. It's not derived
//     from any documented mask format - it was reverse-engineered by
//     matching date+amount pairs across real fixture accounts (e.g. 6600's
//     outbound "$5,000.00 TFR TO SHARES #######66-72" on 01/07/2025 lines
//     up exactly with 6723's inbound "$5,000.00 TFR FROM SHARES
//     #######66-00" the same day):
//       66-00 -> 6600   66-71 -> 6715   66-72 -> 6723
//       66-73 -> 6731   66-21 -> 6621
//
// The loan's own ledger never prints "LOAN PYMT FRM CHECKG" the way the
// spec's pattern list implies - it just prints "Regular Payment" (see
// rows.js). Every loan payment transaction is therefore always the inbound
// side of a LOAN PYMT TO LOAN transfer, matched by amount + date alone -
// the loan side carries no counterparty account text to check against.
//
// Overdraft Transfer doesn't name a counterparty account in either variant -
// matched by kind + amount + date only, same no-self-transfer guard as
// everything else.
const SHARES_SUFFIX_TO_ACCOUNT = {
  '66-00': '6600',
  '66-71': '6715',
  '66-72': '6723',
  '66-73': '6731',
  '66-21': '6621',
};

const RE_CHECKG = /TFR (TO|FRM|FROM) CHECKG x(\d{4})/i;
// Variant B calls a transfer to/from the savings account (6600) "SAVGS",
// not "CHECKG" - 6600 isn't a checking account. Found by tracing why every
// 6600<->6723 transfer in the current-format months was going unmatched.
const RE_SAVGS = /TFR (TO|FRM|FROM) SAVGS x(\d{4})/i;
const RE_SHARES = /TFR (TO|FROM|FRM) SHARES #+(\d{2}-\d{2})/i;
const RE_LOAN_OUT_B = /LOAN PYMT TO LOAN x(\d{4})/i;
const RE_LOAN_OUT_A = /TFR TO LOAN #+(\d{2}-\d{2})/i;
const RE_OVERDRAFT = /Overdraft Transfer/i;

const DATE_WINDOW_DAYS = 2;
const AMOUNT_TOLERANCE = 0.02;

function toDayNumber(mdy) {
  const [m, d, y] = mdy.split('/').map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 86400000);
}

function classify(tx, accountKind) {
  const d = tx.description || '';

  const loanOutB = d.match(RE_LOAN_OUT_B);
  if (loanOutB) return { kind: 'loan', counterpartyAccount: loanOutB[1] };

  const loanOutA = d.match(RE_LOAN_OUT_A);
  if (loanOutA) return { kind: 'loan', counterpartyAccount: SHARES_SUFFIX_TO_ACCOUNT[loanOutA[1]] || null };

  if (accountKind === 'loan' && tx.type === 'payment') {
    return { kind: 'loan', counterpartyAccount: null };
  }

  const checkg = d.match(RE_CHECKG);
  if (checkg) return { kind: 'checkg', counterpartyAccount: checkg[2] };

  const savgs = d.match(RE_SAVGS);
  if (savgs) return { kind: 'checkg', counterpartyAccount: savgs[2] };

  const shares = d.match(RE_SHARES);
  if (shares) return { kind: 'checkg', counterpartyAccount: SHARES_SUFFIX_TO_ACCOUNT[shares[2]] || null };

  if (RE_OVERDRAFT.test(d)) return { kind: 'overdraft', counterpartyAccount: null };

  return null;
}

function directionOf(tx) {
  if (tx.type === 'debit') return 'out';
  if (tx.type === 'credit') return 'in';
  if (tx.type === 'payment') return 'in';  // a loan payment always reduces the loan
  return null;
}

// sections: array of parseStatement() results, each tagged with a `file`
// property identifying which statement it came from.
function matchTransfers(sections) {
  const candidates = [];
  for (const sec of sections) {
    for (const tx of sec.transactions) {
      if (tx.flag !== 'OK') continue;  // unreconciled rows never enter the P&L
      const info = classify(tx, sec.kind);
      if (!info) continue;
      const direction = directionOf(tx);
      if (!direction) continue;
      candidates.push({
        file: sec.file,
        accountNumber: sec.number,
        date: tx.date,
        day: toDayNumber(tx.date),
        amount: Math.abs(tx.amount),
        description: tx.description,
        kind: info.kind,
        counterpartyAccount: info.counterpartyAccount,
        direction,
        matched: false,
      });
    }
  }

  const outbound = candidates.filter(c => c.direction === 'out').sort((a, b) => a.day - b.day);
  const inbound = candidates.filter(c => c.direction === 'in');

  const matches = [];
  for (const out of outbound) {
    let best = null;
    let bestDiff = Infinity;
    for (const inn of inbound) {
      if (inn.matched) continue;
      if (inn.kind !== out.kind) continue;
      if (inn.accountNumber === out.accountNumber) continue;
      if (Math.abs(inn.amount - out.amount) > AMOUNT_TOLERANCE) continue;
      const dayDiff = Math.abs(inn.day - out.day);
      if (dayDiff > DATE_WINDOW_DAYS) continue;
      if (out.counterpartyAccount && inn.accountNumber !== out.counterpartyAccount) continue;
      if (inn.counterpartyAccount && inn.counterpartyAccount !== out.accountNumber) continue;
      if (dayDiff < bestDiff) { best = inn; bestDiff = dayDiff; }
    }
    if (best) {
      best.matched = true;
      out.matched = true;
      matches.push({ out, in: best, amount: out.amount });
    }
  }

  const unmatched = candidates.filter(c => !c.matched);
  const volumeEliminated = matches.reduce((s, m) => s + m.amount, 0);

  return { matches, unmatched, volumeEliminated };
}

module.exports = { matchTransfers, classify };
