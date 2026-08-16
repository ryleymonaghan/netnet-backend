// Step 2 of the SC Federal parser rebuild (NETNET_PARSER_SPEC.md): track the
// current account section across page breaks and collect each account's
// beginning/ending balance.
//
// Both statement variants print the account's short nickname in caps
// ("EASY BUSINESS CKING") on every page, including continuation pages, and
// it matches the spec's account table exactly — so we key off that instead
// of decoding either variant's account-number mask. But the two variants
// place it differently:
//   - Variant B (current): the nickname is its own line, directly below a
//     verbose label + masked account line ("Easy Business Checking -
//     XXXXXX6715").
//   - Variant A (legacy): the nickname and the masked account are on the
//     SAME line ("BUS SERVICES SAV - XXXXXX6-00"), with no separate
//     verbose-label line.
// The header regex below matches the nickname as a line prefix with an
// optional " - XXXXXX..." / "(continued)" suffix, which covers both shapes
// without caring which one it's looking at.
//
// The state machine only switches sections on a recognized nickname line
// and otherwise carries the current section forward across every other
// line, including page-footer noise — so it doesn't matter whether a given
// page repeats the header or not.
//
// 7466 is the member number, not an account. It only ever appears in
// "Member Number:" and page-footer lines, never as a section nickname, so
// it's excluded by construction rather than by a special-case filter.
const RE_MONEY = /-?\$[\d,]+\.\d{2}/g;
const RE_BEGIN = /\b(Beginning Balance|Previous Balance)\b/i;
const RE_END = /\b(Ending Balance|New Balance)\b/i;

const ACCOUNTS = {
  'BUS SERVICES SAV':    { number: '6600', kind: 'deposit' },
  'EASY BUSINESS CKING': { number: '6715', kind: 'deposit' },
  'PR BUSINESS CKING':   { number: '6723', kind: 'deposit' },
  'BILL PAY CKING':      { number: '6731', kind: 'deposit' },
  'BUS SECURED TERM':    { number: '6621', kind: 'loan' },
};

const NICKNAMES = Object.keys(ACCOUNTS).sort((a, b) => b.length - a.length);
const RE_HEADER = new RegExp(
  `^(${NICKNAMES.join('|')})(?:\\s*-\\s*XXXXXX[\\dX-]+)?\\s*(?:\\(continued\\))?$`
);

const money = s => Number(String(s).replace(/[$,]/g, ''));

function extractAccountSections(rawText) {
  const lines = String(rawText || '').split('\n').map(l => l.trim()).filter(Boolean);

  const sections = new Map();  // account number -> section record
  let current = null;

  for (const line of lines) {
    const headerMatch = line.match(RE_HEADER);
    if (headerMatch) {
      const acct = ACCOUNTS[headerMatch[1]];
      if (!sections.has(acct.number)) {
        sections.set(acct.number, {
          name: headerMatch[1],
          number: acct.number,
          kind: acct.kind,
          beginningBalance: null,
          endingBalance: null,
        });
      }
      current = sections.get(acct.number);
      continue;
    }

    if (!current) continue;

    const amounts = line.match(RE_MONEY) || [];
    if (!amounts.length) continue;

    if (RE_BEGIN.test(line) && current.beginningBalance === null) {
      current.beginningBalance = money(amounts[amounts.length - 1]);
    } else if (RE_END.test(line)) {
      current.endingBalance = money(amounts[amounts.length - 1]);
    }
  }

  return [...sections.values()];
}

module.exports = { extractAccountSections, ACCOUNTS, RE_HEADER, RE_BEGIN, RE_END, RE_MONEY, money };
