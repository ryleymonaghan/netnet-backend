#!/usr/bin/env node
// Runs parseStatement() against every PDF in test/fixtures/ and prints
// per-account transaction counts and reconciliation rate. Step 3 of
// NETNET_PARSER_SPEC.md — target is >99% reconciled overall.
const fs = require('fs');
const path = require('path');
const { extractStatementText } = require('../lib/parsers/extract');
const { parseStatement } = require('../lib/parsers/rows');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function main() {
  const files = fs.readdirSync(FIXTURES_DIR)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .sort();

  let grandTotal = 0;
  let grandReconciled = 0;

  for (const file of files) {
    const buffer = fs.readFileSync(path.join(FIXTURES_DIR, file));
    const text = await extractStatementText(buffer);
    const sections = parseStatement(text);

    console.log(`\n${file}`);
    for (const s of sections.sort((a, b) => a.number.localeCompare(b.number))) {
      grandTotal += s.totalCount;
      grandReconciled += s.reconciledCount;
      const pctStr = s.reconciledPct === null ? 'n/a' : `${s.reconciledPct.toFixed(1)}%`;
      console.log(
        `  ${s.number} (${s.kind.padEnd(7)}) ${s.name.padEnd(22)} ` +
        `${String(s.totalCount).padStart(4)} rows  ${s.reconciledCount}/${s.totalCount} reconciled (${pctStr})`
      );
      const flagged = s.transactions.filter(t => t.flag !== 'OK');
      for (const t of flagged.slice(0, 5)) {
        console.log(`      FLAGGED ${t.date} "${t.description.slice(0, 50)}" — ${t.note || t.flag}`);
      }
      if (flagged.length > 5) console.log(`      ... and ${flagged.length - 5} more flagged`);
    }
  }

  const overallPct = grandTotal ? (grandReconciled / grandTotal) * 100 : 0;
  console.log(`\n=== OVERALL: ${grandReconciled}/${grandTotal} reconciled (${overallPct.toFixed(2)}%) ===`);
}

main();
