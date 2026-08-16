#!/usr/bin/env node
// Runs matchTransfers() across ALL 12 fixtures combined (not per-file) since
// a transfer near a month boundary can have its counterpart in the
// adjacent month's statement. Prints total volume eliminated and the full
// unmatched list — an unmatched transfer means a missing statement or a
// parse failure, not a real transaction, so it's never dropped silently.
const fs = require('fs');
const path = require('path');
const { extractStatementText } = require('../lib/parsers/extract');
const { parseStatement } = require('../lib/parsers/rows');
const { matchTransfers } = require('../lib/parsers/transfers');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function main() {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  const allSections = [];
  for (const file of files) {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, file));
    const text = await extractStatementText(buffer);
    const sections = parseStatement(text);
    for (const s of sections) allSections.push({ ...s, file });
  }

  const { matches, unmatched, volumeEliminated } = matchTransfers(allSections);

  console.log(`Matched pairs: ${matches.length}`);
  console.log(`Transfer volume eliminated: $${volumeEliminated.toFixed(2)}`);
  console.log(`Unmatched: ${unmatched.length}`);

  if (unmatched.length) {
    console.log('\n--- UNMATCHED TRANSFERS (missing statement or parse failure) ---');
    for (const u of unmatched.sort((a, b) => a.day - b.day)) {
      console.log(
        `  ${u.file}  ${u.date}  acct ${u.accountNumber}  ${u.direction.padEnd(3)}  ` +
        `$${u.amount.toFixed(2).padStart(10)}  [${u.kind}]  ` +
        `counterparty=${u.counterpartyAccount || '?'}  "${u.description.slice(0, 60)}"`
      );
    }
  }

  const byKind = {};
  for (const m of matches) byKind[m.out.kind] = (byKind[m.out.kind] || 0) + 1;
  console.log('\nMatched by kind:', byKind);
}

main();
