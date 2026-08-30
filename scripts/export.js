#!/usr/bin/env node
// Runs the full pipeline (rows -> transfers -> categorize) across all 12
// SC Federal 2025 fixtures and writes two CSVs to exports/:
//   transactions_2025.csv   — every parsed row with its category split(s)
//   summary_2025.csv        — P&L totals + the balance reconciliation check
//   zelle_2025.csv          — every Zelle inflow, by sender, for Ryley to
//                             annotate line by line. Splits the senders who
//                             actually are related parties (Monaghan,
//                             McGillis) from the ones who are not. The
//                             non-family senders are the open question: each
//                             is a gift, a capital contribution, a loan, or
//                             taxable gross receipts, and the IRS default
//                             for an undocumented inbound transfer to a
//                             business is income.
//
// The reconciliation check compares actual net cash movement in the 4
// deposit accounts (6600/6715/6723/6731) against the category totals, and
// is asserted rather than silently adjusted — see the "note" column in
// summary_2025.csv if it doesn't tie out.
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { extractStatementText } = require('../lib/parsers/extract');
const { parseStatement } = require('../lib/parsers/rows');
const { matchTransfers } = require('../lib/parsers/transfers');
const { categorizeTransaction, extractZelleSender } = require('../lib/parsers/categorize');

const FIXTURES_DIR = path.join(__dirname, '../test/fixtures');
const EXPORTS_DIR = path.join(__dirname, '../exports');
const DEPOSIT_ACCOUNTS = ['6600', '6715', '6723', '6731'];
const LIABILITY_CATEGORIES = new Set(['CREDIT_CARD_PAYMENT', 'LOC_PAYMENT', 'LOAN_PRINCIPAL', 'TAX_PAYMENT', 'MORTGAGE', 'EQUIPMENT_LOAN']);

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

  // ── transactions_2025.csv ────────────────────────────────────────────────
  const txRows = [];
  const zelleRows = [];
  // Ryley's answers of 2026-08-18, carried into the export so the CSV records
  // WHO decided each bucket and on what date, not just the number.
  const RYLEY_CLASSIFICATION = {
    REVENUE: 'REVENUE',
    BUSINESS_REFUND: 'SUB_REFUND',
    GIFT: 'GIFT',
    ZELLE_UNKNOWN_SENDER: '',
  };
  const CLASSIFICATION_NOTE = {
    REVENUE: 'Customer payment. Confirmed by Ryley 2026-08-18.',
    BUSINESS_REFUND: 'OAB paid this sub in 2025; the inflow is a refund, not gross receipts. Reduces subcontractor expense. Confirmed by Ryley 2026-08-18.',
    GIFT: 'Gift from family. Not income to the recipient. Ryley 2026-08-19.',
    ZELLE_UNKNOWN_SENDER: 'OPEN - unidentified sender.',
  };
  for (const sec of allSections) {
    for (const tx of sec.transactions) {
      const base = {
        file: sec.file,
        account: sec.number,
        date: tx.date,
        description: tx.description || tx.note || '(no description)',
        type: tx.type || '',
        amount: tx.amount ?? '',
        flag: tx.flag || '',
        transfer_tag: tx.transferTag || '',
      };

      if (tx.flag !== 'OK') {
        txRows.push({ ...base, category: '', category_label: '', split_amount: '', review_note: tx.note || '' });
        continue;
      }

      for (const split of categorizeTransaction(tx, sec.number)) {
        txRows.push({
          ...base,
          category: split.category,
          category_label: split.label,
          split_amount: split.amount,
          review_note: split.reviewNote || '',
        });

        // Every Zelle inflow lands here regardless of bucket, so this file is
        // the complete audit trail of how each sender was treated - including
        // the ones that are now revenue. A row with a blank
        // ryley_classification is still open.
        if (split.zelleSender !== undefined) {
          zelleRows.push({
            date: tx.date,
            account: sec.number,
            sender: extractZelleSender(base.description) || '(unparsed)',
            amount: Number(split.amount).toFixed(2),
            auto_classification: split.category,
            ryley_classification: RYLEY_CLASSIFICATION[split.category] || '',
            notes: CLASSIFICATION_NOTE[split.category] || '',
          });
        }
      }
    }
  }
  txRows.sort((a, b) => a.date.localeCompare(b.date));

  // ── P&L totals (mirrors test/categorize.test.js) ────────────────────────
  const businessByCategory = {};
  const liabilityByCategory = {};
  const insuranceByCategory = {};
  let grossReceipts = 0, giftTotal = 0, personalTotal = 0, distributionTotal = 0;
  let zelleUnknownTotal = 0;
  let zelleRevenue = 0, businessRefundTotal = 0;
  const zelleUnknownBySender = {};
  let healthInsuranceTotal = 0;
  const reviewQueue = [];

  for (const sec of allSections) {
    for (const tx of sec.transactions) {
      if (tx.flag !== 'OK') {
        reviewQueue.push({ reason: 'UNRECONCILED' });
        continue;
      }
      const splits = categorizeTransaction(tx, sec.number);
      const isOutflow = tx.type === 'debit' || tx.principal != null;
      const signed = tx.type === 'credit' ? -1 : 1;

      for (const split of splits) {
        if (split.category === 'CREDIT_CARD_PAYMENT') {
          liabilityByCategory[split.label] = (liabilityByCategory[split.label] || 0) + signed * split.amount;
        } else if (split.category === 'HEALTH_INSURANCE') {
          // UnitedHealthcare bounced twice and was refunded twice in June —
          // net debits against credits or the P&L overstates the premium.
          healthInsuranceTotal += signed * split.amount;
        } else if (split.category === 'INSURANCE') {
          insuranceByCategory[split.label] = (insuranceByCategory[split.label] || 0) + split.amount;
        } else if (split.category === 'BUSINESS' && isOutflow) {
          businessByCategory[split.label] = (businessByCategory[split.label] || 0) + split.amount;
        } else if (LIABILITY_CATEGORIES.has(split.category) && isOutflow) {
          liabilityByCategory[split.label] = (liabilityByCategory[split.label] || 0) + split.amount;
        } else if (split.category === 'REVENUE') {
          grossReceipts += split.amount;
          if (split.zelleSender) zelleRevenue += split.amount;
        } else if (split.category === 'BUSINESS_REFUND') {
          // A credit, so it does not belong in businessByCategory (which sums
          // outflows). Netted against the business total below.
          businessRefundTotal += split.amount;
        } else if (split.category === 'GIFT') {
          giftTotal += split.amount;
        } else if (split.category === 'ZELLE_UNKNOWN_SENDER') {
          // Deliberately NOT folded into gross receipts. Probably revenue,
          // unconfirmed, and guessing here would overstate income as easily
          // as omitting it understates it.
          zelleUnknownTotal += split.amount;
          const zSender = extractZelleSender(tx.description || tx.note || '') || '(unparsed)';
          zelleUnknownBySender[zSender] = (zelleUnknownBySender[zSender] || 0) + split.amount;
          reviewQueue.push({ reason: split.label });
        } else if (split.category === 'PERSONAL' && tx.type === 'debit') {
          personalTotal += split.amount;
          distributionTotal += split.amount;
        } else if (split.category === 'REVIEW') {
          reviewQueue.push({ reason: split.label });
        }
        if (split.reviewNote) reviewQueue.push({ reason: split.reviewNote });
      }
    }
  }

  const businessGross = Object.values(businessByCategory).reduce((s, v) => s + v, 0);
  const businessTotal = businessGross - businessRefundTotal;
  const liabilityTotal = Object.values(liabilityByCategory).reduce((s, v) => s + v, 0);
  const insuranceTotal = Object.values(insuranceByCategory).reduce((s, v) => s + v, 0);

  // ── Balance reconciliation: net change in the 4 deposit accounts' actual
  // balances vs. the P&L category totals. Statements are sorted by the
  // transaction dates they contain, NOT by filename — "1:31:25.pdf" (Jan)
  // sorts alphabetically before "2:28:25.pdf" (Feb) only by coincidence of
  // single-digit months; "10:31:25.pdf" (Oct) sorts before "2:28:25.pdf"
  // (Feb) alphabetically, which is wrong, so filename order cannot be
  // trusted for "first/last statement of the year".
  const byAccount = {};
  for (const sec of allSections) {
    if (!DEPOSIT_ACCOUNTS.includes(sec.number)) continue;
    (byAccount[sec.number] = byAccount[sec.number] || []).push(sec);
  }
  const dateRange = (sec) => {
    const dates = sec.transactions.map(t => t.date).filter(Boolean).sort();
    return { min: dates[0] || null, max: dates[dates.length - 1] || null };
  };

  let combinedBeginning = 0, combinedEnding = 0;
  for (const acct of DEPOSIT_ACCOUNTS) {
    const secs = (byAccount[acct] || []).map(s => ({ ...s, range: dateRange(s) }));
    secs.sort((a, b) => (a.range.min || '').localeCompare(b.range.min || ''));
    if (!secs.length) continue;
    combinedBeginning += secs[0].beginningBalance || 0;
    combinedEnding += secs[secs.length - 1].endingBalance || 0;
  }
  const netBalanceChange = Number((combinedEnding - combinedBeginning).toFixed(2));

  // Every category's net signed cash effect (credit +, debit -), 4 deposit
  // accounts only. This sums to the true net cash flow by construction (it's
  // every dollar that moved, bucketed) and is the real tie-out check.
  const netByCategory = {};
  for (const sec of allSections) {
    if (!DEPOSIT_ACCOUNTS.includes(sec.number)) continue;
    for (const tx of sec.transactions) {
      if (tx.flag !== 'OK') continue;
      const signed = tx.type === 'credit' ? 1 : -1;
      for (const split of categorizeTransaction(tx, sec.number)) {
        netByCategory[split.category] = (netByCategory[split.category] || 0) + signed * split.amount;
      }
    }
  }
  const fullyAccountedTotal = Number(
    Object.values(netByCategory).reduce((s, v) => s + v, 0).toFixed(2)
  );

  const leftSide = Number((
    grossReceipts - (businessTotal + liabilityTotal + personalTotal + healthInsuranceTotal + insuranceTotal)
  ).toFixed(2));
  const difference = Number((leftSide - netBalanceChange).toFixed(2));
  const fullyAccountedDiff = Number((fullyAccountedTotal - netBalanceChange).toFixed(2));

  // ── summary_2025.csv ─────────────────────────────────────────────────────
  const summaryRows = [
    { section: 'P&L', label: 'Gross Receipts (REVENUE)', amount: grossReceipts.toFixed(2) },
    {
      section: 'P&L', label: 'Gross Receipts - of which customer Zelle (confirmed 2026-08-18)',
      amount: zelleRevenue.toFixed(2),
      note: 'Memo line, already inside Gross Receipts above - do not add. Bruce Matt, Abigail Smith, Rose Dodson, James J Dye. Confirmed customers per Ryley 2026-08-18.',
    },
    { section: 'P&L', label: 'Gifts received (Zelle from Monaghan, not income)', amount: giftTotal.toFixed(2) },
    {
      section: 'P&L', label: 'Zelle - UNKNOWN SENDERS (UNCLASSIFIED, not in revenue)',
      amount: zelleUnknownTotal.toFixed(2),
      note: zelleUnknownTotal === 0
        ? 'Empty. Every 2025 Zelle sender has been identified and classified.'
        : 'Not family. Each line is a gift, capital contribution, loan, or taxable gross receipts. See zelle_2025.csv. If these are customer payments, gross receipts increase by this amount.',
    },
    ...Object.entries(zelleUnknownBySender).sort((a, b) => b[1] - a[1]).map(([sender, amount]) => ({
      section: 'Zelle Unknown Sender', label: sender, amount: amount.toFixed(2),
    })),
    ...Object.entries(businessByCategory).sort((a, b) => b[1] - a[1])
      .map(([label, amount]) => ({ section: 'Business Expense', label, amount: amount.toFixed(2) })),
    {
      section: 'Business Expense', label: 'Subcontractor refund (Chetos Concrete, credit)',
      amount: (-businessRefundTotal).toFixed(2),
      note: 'Inflow from a sub OAB paid in 2025. Netted against expense rather than booked as revenue, per Ryley 2026-08-18.',
    },
    { section: 'Business Expense', label: 'TOTAL (net of refunds)', amount: businessTotal.toFixed(2) },
    ...Object.entries(liabilityByCategory).sort((a, b) => b[1] - a[1])
      .map(([label, amount]) => ({ section: 'Liability Payment', label, amount: amount.toFixed(2) })),
    { section: 'Liability Payment', label: 'TOTAL', amount: liabilityTotal.toFixed(2) },
    {
      section: 'Health Insurance', label: 'Health Insurance (UnitedHealthcare/BCBS, net of June refunds)',
      amount: healthInsuranceTotal.toFixed(2),
    },
    ...Object.entries(insuranceByCategory).sort((a, b) => b[1] - a[1])
      .map(([label, amount]) => ({ section: 'Insurance', label, amount: amount.toFixed(2) })),
    { section: 'Insurance', label: 'TOTAL', amount: insuranceTotal.toFixed(2) },
    { section: 'P&L', label: 'Personal (Shareholder Distribution)', amount: personalTotal.toFixed(2) },
    { section: 'P&L', label: 'SHAREHOLDER_DISTRIBUTION', amount: distributionTotal.toFixed(2) },
    { section: 'Review Queue', label: 'Item count', amount: reviewQueue.length },
    { section: 'Reconciliation', label: 'Combined beginning balance (4 deposit accounts)', amount: combinedBeginning.toFixed(2) },
    { section: 'Reconciliation', label: 'Combined ending balance (4 deposit accounts)', amount: combinedEnding.toFixed(2) },
    { section: 'Reconciliation', label: 'Net change in combined balances', amount: netBalanceChange.toFixed(2) },
    {
      section: 'Reconciliation',
      label: 'Gross Receipts - (Business + Liability + Insurance + Health Insurance + Personal)',
      amount: leftSide.toFixed(2),
    },
    {
      section: 'Reconciliation', label: 'Difference vs. net balance change',
      amount: difference.toFixed(2),
      note: Math.abs(difference) > 3000
        ? 'OFF BY MORE THAN A FEW THOUSAND. The formula above still omits real cash-moving categories: GIFT (Zelle inflows), the checking-side leg of loan payments (tagged INTERNAL_TRANSFER but really leaves the 4-account universe), REVIEW-queue items (6731 defaults to REVIEW, not BUSINESS), and stray non-transfer activity in the dormant 6600 account. See "Fully-accounted total" below, which includes all of them and ties out.'
        : 'Within tolerance.',
    },
    { section: 'Reconciliation', label: 'Fully-accounted total (all categories, net signed)', amount: fullyAccountedTotal.toFixed(2) },
    {
      section: 'Reconciliation', label: 'Fully-accounted diff vs. net balance change',
      amount: fullyAccountedDiff.toFixed(2),
      note: Math.abs(fullyAccountedDiff) > 3000 ? 'STILL OFF BY MORE THAN A FEW THOUSAND — needs investigation, not adjustment.' : 'Ties out within tolerance.',
    },
  ];

  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXPORTS_DIR, 'transactions_2025.csv'), Papa.unparse(txRows));
  fs.writeFileSync(path.join(EXPORTS_DIR, 'summary_2025.csv'), Papa.unparse(summaryRows));

  zelleRows.sort((a, b) => a.date.localeCompare(b.date));

  // The same person shows up under two spellings ("MONAGHAN CHERYL" on the
  // January row, "CHERYL MONAGHAN" on every row after), which would split one
  // sender's total across two lines. Group on the sorted name tokens so word
  // order stops mattering, without hardcoding who anyone is; display the
  // spelling that appears most often. Per-transaction rows keep the raw
  // sender string exactly as the bank printed it.
  const nameKey = (s) => s.toUpperCase().replace(/[^A-Z ]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
  const senderTotals = {};
  for (const r of zelleRows) {
    const key = nameKey(r.sender);
    const t = senderTotals[key] = senderTotals[key] || { amount: 0, count: 0, auto: r.auto_classification, spellings: {} };
    t.amount += Number(r.amount);
    t.count += 1;
    t.spellings[r.sender] = (t.spellings[r.sender] || 0) + 1;
  }
  const zelleRows2 = [
    ...zelleRows,
    ...Object.entries(senderTotals).sort((a, b) => b[1].amount - a[1].amount).map(([, t]) => ({
      date: 'TOTAL', account: '',
      sender: Object.entries(t.spellings).sort((a, b) => b[1] - a[1])[0][0],
      amount: t.amount.toFixed(2),
      auto_classification: t.auto,
      ryley_classification: RYLEY_CLASSIFICATION[t.auto] || '',
      notes: `${t.count} transfer(s)`,
    })),
  ];
  fs.writeFileSync(path.join(EXPORTS_DIR, 'zelle_2025.csv'), Papa.unparse(zelleRows2));

  console.log(`Wrote ${txRows.length} rows to exports/transactions_2025.csv`);
  console.log(`Wrote ${summaryRows.length} rows to exports/summary_2025.csv`);
  console.log(`Wrote ${zelleRows2.length} rows to exports/zelle_2025.csv`);
  console.log(`Gross receipts: $${grossReceipts.toFixed(2)} (of which customer Zelle: $${zelleRevenue.toFixed(2)})`);
  console.log(`Gifts (Monaghan): $${giftTotal.toFixed(2)}  |  Zelle UNKNOWN senders: $${zelleUnknownTotal.toFixed(2)}  |  Sub refund: $${businessRefundTotal.toFixed(2)}`);
  console.log(`Net balance change: $${netBalanceChange.toFixed(2)}  |  Formula left side: $${leftSide.toFixed(2)}  |  Diff: $${difference.toFixed(2)}`);
  console.log(`Fully-accounted total: $${fullyAccountedTotal.toFixed(2)}  |  Diff: $${fullyAccountedDiff.toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
