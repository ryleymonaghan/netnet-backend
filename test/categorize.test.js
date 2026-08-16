#!/usr/bin/env node
// Runs the full pipeline (rows -> transfers -> categorize) across all 12
// fixtures and prints the category engine's output: business expenses by
// category, personal total, shareholder distribution total, and the
// review-queue count. NETNET_PARSER_SPEC.md's category engine + account
// default matrix + SHAREHOLDER_DISTRIBUTION tally, combined.
const fs = require('fs');
const path = require('path');
const { extractStatementText } = require('../lib/parsers/extract');
const { parseStatement } = require('../lib/parsers/rows');
const { matchTransfers } = require('../lib/parsers/transfers');
const { categorizeTransaction } = require('../lib/parsers/categorize');

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

  // Mutates tx.transferTag on the underlying transaction objects.
  matchTransfers(allSections);

  const businessByCategory = {};
  let personalTotal = 0;
  let distributionTotal = 0;
  const reviewQueue = [];

  for (const sec of allSections) {
    for (const tx of sec.transactions) {
      if (tx.flag !== 'OK') {
        reviewQueue.push({ file: sec.file, account: sec.number, date: tx.date, reason: 'UNRECONCILED', description: tx.description || tx.note });
        continue;
      }

      const splits = categorizeTransaction(tx, sec.number);
      const isOutflow = tx.type === 'debit' || tx.principal != null;

      for (const split of splits) {
        if (split.category === 'BUSINESS' && isOutflow) {
          businessByCategory[split.label] = (businessByCategory[split.label] || 0) + split.amount;
        } else if (split.category === 'PERSONAL' && tx.type === 'debit') {
          personalTotal += split.amount;
          distributionTotal += split.amount;  // every PERSONAL debit is paid from a business account
        } else if (split.category === 'REVIEW') {
          reviewQueue.push({ file: sec.file, account: sec.number, date: tx.date, reason: split.label, description: tx.description });
        }
        // EXCLUDE and INTERNAL_TRANSFER: intentionally not counted anywhere.
      }
    }
  }

  console.log('=== BUSINESS EXPENSES BY CATEGORY ===');
  const sorted = Object.entries(businessByCategory).sort((a, b) => b[1] - a[1]);
  let businessTotal = 0;
  for (const [label, amount] of sorted) {
    businessTotal += amount;
    console.log(`  ${label.padEnd(40)} $${amount.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(40)} $${businessTotal.toFixed(2).padStart(12)}`);

  console.log('\n=== PERSONAL TOTAL ===');
  console.log(`  $${personalTotal.toFixed(2)}`);

  console.log('\n=== SHAREHOLDER_DISTRIBUTION ===');
  console.log(`  $${distributionTotal.toFixed(2)}`);

  console.log('\n=== REVIEW QUEUE ===');
  console.log(`  ${reviewQueue.length} items`);
  const reasonCounts = {};
  for (const r of reviewQueue) reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
  console.log('  by reason:', reasonCounts);
}

main();
