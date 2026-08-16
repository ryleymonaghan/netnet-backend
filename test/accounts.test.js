#!/usr/bin/env node
// Runs extractAccountSections() against every PDF in test/fixtures/ and
// prints the account sections found per statement with their
// beginning/ending balance. Step 2 of NETNET_PARSER_SPEC.md — no
// transaction parsing yet, just confirming the state machine finds the
// right 5 accounts (never the 7466 member number) with sane balances.
const fs = require('fs');
const path = require('path');
const { extractStatementText } = require('../lib/parsers/extract');
const { extractAccountSections, ACCOUNTS } = require('../lib/parsers/accounts');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const EXPECTED_ACCOUNT_COUNT = Object.keys(ACCOUNTS).length;

async function main() {
  if (!fs.existsSync(FIXTURES_DIR)) {
    console.error(`Fixtures directory not found: ${FIXTURES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  if (files.length === 0) {
    console.error(`No PDF fixtures found in ${FIXTURES_DIR}`);
    process.exit(1);
  }

  for (const file of files) {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, file));
    let text;
    try {
      text = await extractStatementText(buffer);
    } catch (e) {
      console.log(`\n${file}\n  ERROR extracting text: ${e.message}`);
      continue;
    }

    const sections = extractAccountSections(text);
    const flagged = sections.length !== EXPECTED_ACCOUNT_COUNT;
    const suffix = flagged ? `  <-- expected ${EXPECTED_ACCOUNT_COUNT}` : '';

    console.log(`\n${file}  (${sections.length} accounts found${suffix})`);
    for (const s of sections.sort((a, b) => a.number.localeCompare(b.number))) {
      const begin = s.beginningBalance === null ? 'MISSING' : `$${s.beginningBalance.toFixed(2)}`;
      const end = s.endingBalance === null ? 'MISSING' : `$${s.endingBalance.toFixed(2)}`;
      console.log(
        `  ${s.number} (${s.kind.padEnd(7)}) ${s.name.padEnd(22)} ` +
        `beginning ${begin.padStart(12)}  ending ${end.padStart(12)}`
      );
    }
  }
}

main();
