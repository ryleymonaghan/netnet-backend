#!/usr/bin/env node
// Runs the full pipeline (rows -> transfers -> categorize) across all 12
// fixtures and prints the category engine's output: gross receipts,
// business expenses by category, liability payments (excluded), personal
// total, shareholder distribution total, and the review-queue count.
// NETNET_PARSER_SPEC.md's category engine + account default matrix +
// SHAREHOLDER_DISTRIBUTION tally, combined.
const fs = require('fs');
const path = require('path');
const { extractStatementText } = require('../lib/parsers/extract');
const { parseStatement } = require('../lib/parsers/rows');
const { matchTransfers } = require('../lib/parsers/transfers');
const { categorizeTransaction } = require('../lib/parsers/categorize');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const LIABILITY_CATEGORIES = new Set(['CREDIT_CARD_PAYMENT', 'LOC_PAYMENT', 'LOAN_PRINCIPAL', 'TAX_PAYMENT', 'MORTGAGE', 'EQUIPMENT_LOAN']);
// BUSINESS and liability totals are netted debit-minus-credit rather than
// summed debit-only, so a bounced/retried ACH attempt (a debit immediately
// reversed by a matching credit) doesn't inflate the total - see the
// CREDIT_CARD_PAYMENT overcounting bug this was built to catch.

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
  const liabilityByCategory = {};
  const insuranceByCategory = {};
  let grossReceipts = 0;
  let giftTotal = 0;
  let personalTotal = 0;
  let distributionTotal = 0;
  let healthInsuranceTotal = 0;
  const reviewQueue = [];
  const taxPaymentRows = [];
  const creditCardRows = [];

  for (const sec of allSections) {
    for (const tx of sec.transactions) {
      if (tx.flag !== 'OK') {
        reviewQueue.push({ file: sec.file, account: sec.number, date: tx.date, reason: 'UNRECONCILED', description: tx.description || tx.note });
        continue;
      }

      const splits = categorizeTransaction(tx, sec.number);
      const isOutflow = tx.type === 'debit' || tx.principal != null;
      // CREDIT_CARD_PAYMENT is the one category confirmed to need netting:
      // rejected/retried ACH card payments post a debit AND a reversing
      // credit for the same attempt, and summing debits alone double-counts
      // the bounced ones. Every other category (TAX_PAYMENT included,
      // confirmed correct as debit-only at $14,036) keeps the original
      // debit-only behavior - don't generalize past what's confirmed broken.
      const signed = tx.type === 'credit' ? -1 : 1;

      for (const split of splits) {
        if (split.category === 'TAX_PAYMENT') {
          taxPaymentRows.push({ file: sec.file, account: sec.number, date: tx.date, type: tx.type, amount: split.amount, description: tx.description });
        }
        if (split.category === 'CREDIT_CARD_PAYMENT') {
          creditCardRows.push({ file: sec.file, account: sec.number, date: tx.date, type: tx.type, amount: split.amount, description: tx.description });
        }

        if (split.category === 'CREDIT_CARD_PAYMENT') {
          liabilityByCategory[split.label] = (liabilityByCategory[split.label] || 0) + signed * split.amount;
        } else if (split.category === 'HEALTH_INSURANCE') {
          // UnitedHealthcare bounced twice and was refunded twice in June -
          // net debits against credits, same reason as CREDIT_CARD_PAYMENT.
          healthInsuranceTotal += signed * split.amount;
        } else if (split.category === 'INSURANCE') {
          insuranceByCategory[split.label] = (insuranceByCategory[split.label] || 0) + split.amount;
        } else if (split.category === 'BUSINESS' && isOutflow) {
          businessByCategory[split.label] = (businessByCategory[split.label] || 0) + split.amount;
        } else if (LIABILITY_CATEGORIES.has(split.category) && isOutflow) {
          liabilityByCategory[split.label] = (liabilityByCategory[split.label] || 0) + split.amount;
        } else if (split.category === 'REVENUE') {
          grossReceipts += split.amount;
        } else if (split.category === 'GIFT') {
          giftTotal += split.amount;
        } else if (split.category === 'PERSONAL' && tx.type === 'debit') {
          personalTotal += split.amount;
          distributionTotal += split.amount;  // every PERSONAL debit is paid from a business account
        } else if (split.category === 'REVIEW') {
          reviewQueue.push({ file: sec.file, account: sec.number, date: tx.date, reason: split.label, description: tx.description });
        }
        // EXCLUDE and INTERNAL_TRANSFER: intentionally not counted anywhere.

        if (split.reviewNote) {
          reviewQueue.push({ file: sec.file, account: sec.number, date: tx.date, reason: split.reviewNote, description: tx.description });
        }
      }
    }
  }

  console.log('=== TAX_PAYMENT ROWS (confirmed correct - printed for the record) ===');
  for (const r of taxPaymentRows.sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(`  ${r.file}  acct ${r.account}  ${r.date}  ${r.type.padEnd(6)}  $${r.amount.toFixed(2).padStart(10)}  "${r.description.slice(0, 60)}"`);
  }
  const taxDebitOnly = taxPaymentRows.filter(r => r.type === 'debit').reduce((s, r) => s + r.amount, 0);
  console.log(`  DEBIT-ONLY TOTAL (confirmed correct, not netted): $${taxDebitOnly.toFixed(2)}`);

  console.log('\n=== CREDIT_CARD_PAYMENT ROWS (investigating $89,443 vs confirmed $77,324.50) ===');
  for (const r of creditCardRows.sort((a, b) => a.date.localeCompare(b.date))) {
    console.log(`  ${r.file}  acct ${r.account}  ${r.date}  ${r.type.padEnd(6)}  $${r.amount.toFixed(2).padStart(10)}  "${r.description.slice(0, 70)}"`);
  }
  const ccNet = creditCardRows.reduce((s, r) => s + (r.type === 'debit' ? r.amount : -r.amount), 0);
  console.log(`  NET: $${ccNet.toFixed(2)}`);

  console.log('\n=== GROSS RECEIPTS ===');
  console.log(`  $${grossReceipts.toFixed(2)}`);

  console.log('\n=== GIFT (Zelle - not income) ===');
  console.log(`  $${giftTotal.toFixed(2)}`);

  console.log('\n=== BUSINESS EXPENSES BY CATEGORY ===');
  const sortedBusiness = Object.entries(businessByCategory).sort((a, b) => b[1] - a[1]);
  let businessTotal = 0;
  for (const [label, amount] of sortedBusiness) {
    businessTotal += amount;
    console.log(`  ${label.padEnd(40)} $${amount.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(40)} $${businessTotal.toFixed(2).padStart(12)}`);

  console.log('\n=== LIABILITY PAYMENTS (excluded from business expenses) ===');
  const sortedLiability = Object.entries(liabilityByCategory).sort((a, b) => b[1] - a[1]);
  let liabilityTotal = 0;
  for (const [label, amount] of sortedLiability) {
    liabilityTotal += amount;
    console.log(`  ${label.padEnd(40)} $${amount.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(40)} $${liabilityTotal.toFixed(2).padStart(12)}`);

  console.log('\n=== HEALTH INSURANCE (net of June bounces/refunds) ===');
  console.log(`  $${healthInsuranceTotal.toFixed(2)}`);

  console.log('\n=== INSURANCE BY CATEGORY ===');
  const sortedInsurance = Object.entries(insuranceByCategory).sort((a, b) => b[1] - a[1]);
  let insuranceTotal = 0;
  for (const [label, amount] of sortedInsurance) {
    insuranceTotal += amount;
    console.log(`  ${label.padEnd(40)} $${amount.toFixed(2).padStart(12)}`);
  }
  console.log(`  ${'TOTAL'.padEnd(40)} $${insuranceTotal.toFixed(2).padStart(12)}`);

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
