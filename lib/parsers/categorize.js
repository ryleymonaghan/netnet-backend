// Category engine + account default matrix (NETNET_PARSER_SPEC.md). Every
// reconciled, non-transfer transaction gets a category before it can enter
// the P&L or the distribution tally.
//
// Precedence, checked in this order:
//   1. Loan payments (tx.principal != null) split into LOAN_PRINCIPAL (a
//      balance-sheet paydown, not an expense) and interest (BUSINESS - a
//      real deductible expense). This runs BEFORE the transferTag check
//      below: lib/parsers/transfers.js tags the loan's own "Regular
//      Payment" row INTERNAL_TRANSFER too (it's genuinely the inbound leg
//      of the checking account's outbound transfer, fund-flow wise), but
//      categorizing the whole row that way would silently erase the real
//      interest expense. The checking side's OUTBOUND leg of that same
//      transfer has no .principal field, so it falls through to the
//      transferTag check normally and is correctly excluded there - only
//      the loan's own record needs the split.
//   2. INTERNAL_TRANSFER / EXTERNAL_INBOUND / EXTERNAL_OUTBOUND (tagged by
//      transfers.js) - external ones go to the review queue for manual
//      classification; internal ones are excluded outright.
//   3. Account 6600: EXCLUDE unconditionally (dormant, transfers only).
//   4. Liability payments - principal/balance paydowns on debt the
//      business happens to route through its checking accounts. These are
//      NOT business expenses (only interest, fees, or genuinely deductible
//      charges are), so they get their own categories instead of being
//      lumped into BUSINESS: CREDIT_CARD_PAYMENT (Amex), LOC_PAYMENT
//      (Lendica - whole amount for now, principal/fee split needs a fee
//      schedule we don't have), TAX_PAYMENT (IRS - a prior-year personal
//      liability, not a current deductible expense), MORTGAGE (Rocket
//      Mortgage / LoanDepot - principal, not an expense), EQUIPMENT_LOAN
//      (Deere Credit - same lump-sum-for-now treatment as LOC_PAYMENT;
//      statement showing the principal/interest split hasn't arrived yet).
//      Checked regardless of account, same as known-personal below.
//   5. Named expense categories that are real deductible business expenses,
//      just specific enough to break out of the generic BUSINESS bucket:
//      HEALTH_INSURANCE (UnitedHealthcare, BCBS) and INSURANCE (Progressive,
//      Munro, Commercial Insurance, Obsidian - auto/liability/property
//      coverage, distinct from health). Also checked regardless of account.
//      UnitedHealthcare bounced twice and was refunded twice in June 2025
//      (NSF, then a same-amount credit) - callers must net debits against
//      credits for this category rather than summing debits alone, or the
//      bounced attempts double-count as if three months were paid instead
//      of one.
//   6. GIFT / REVENUE - credits into 6715/6723 that look like real
//      deposits (bank deposit, wire) rather than a transfer. Excludes
//      anything also containing TFR, Overdraft, Rejected, or Revers(ed) -
//      those words show up on internal transfers ("Deposit TFR FRM CHECKG
//      x6723"), the account's own overdraft-protection self-refund, and
//      bounced/reversed ACH attempts, none of which are income. Zelle
//      credits are split BY SENDER into four buckets:
//        GIFT                 - GIFT_SENDERS (Cheryl Monaghan). Not revenue,
//                               not related-party receipts. A gift is not
//                               income to the recipient at all.
//        REVENUE              - CUSTOMER_ZELLE_SENDERS. Confirmed customers,
//                               so these ARE gross receipts.
//        BUSINESS_REFUND      - SUB_REFUND_SENDERS. A sub sending money back
//                               reduces the expense; it is not income.
//        ZELLE_UNKNOWN_SENDER - anything else. A REVIEW bucket, NOT revenue
//                               and NOT related-party.
//      An earlier version of this file assumed every Zelle credit was family;
//      that was wrong. 5 non-family senders accounted for ~$55,756 of the
//      ~$102,926. On 2026-08-18 Ryley confirmed each one: four are customers
//      ($55,455.96 -> REVENUE) and Chetos Concrete is a sub OAB paid in 2025
//      ($300 -> BUSINESS_REFUND). Nothing here is inferred. A sender only
//      leaves the review bucket when Ryley has named it. Never guess a sender
//      into revenue.
//   7. Known-personal merchant patterns force PERSONAL - except on 6723,
//      the primary operating account, where a personal-looking charge is
//      flagged for REVIEW instead of auto-classified (per the spec's
//      account matrix: "Flag personal for review"). Coastal Marinas moved
//      here from the 6715 business whitelist - confirmed personal boat slip
//      fees, not a business expense.
//   8. Account defaults: 6715 PERSONAL unless on the business whitelist,
//      6723 BUSINESS, 6731 REVIEW.
const WHITELIST_6715 = [
  'BUCK LUMBER', 'BUILDERSFIRSTSOURCE', "LOWE'S", 'HOME DEPOT', 'TRACTOR SUPPLY',
  'SHERWIN-WILLIAMS', 'HARBOR FREIGHT', 'ALL SEASONS HARDWARE', 'SITEONE',
  'GUSTO', 'ADP', 'INTUIT', 'QUICKBOOKS', 'DOCUSIGN', 'PROPOSIFY', 'JOIST', 'CANVA',
  'ADOBE', 'OPENPHONE', 'BILLER GENIE', 'MERCHANT BANKCD', 'SURFERSEO', 'BLUEHOST',
  'GODADDY', 'MICROSOFT', 'GOOGLE ADS', 'TRIDENT WASTE', 'STARLINK', 'MINT MOBILE',
  'A & R SHEET METAL', 'ISLAND SEPTIC',
];

// IRS - USATAXPYMT, ROCKET MORTGAGE, and LOANDEPOT used to live in this list
// (still flagged personal/review) - moved out to the dedicated liability
// categories below, which are more specific about WHY they're not a
// business expense.
const KNOWN_PERSONAL = [
  'NETFLIX', 'DISNEY PLUS', 'PEACOCK', 'PARAMOUNT+', 'SLING', 'TINDER', 'BUMBLE',
  'ONLYFANS', 'CCBILL', 'SEEKING', 'WINGMAN', 'PURE ANONYMOU', 'ZEDGE',
  'STONO LIQUORS', 'FOOD LION', 'PUBLIX', 'HARRIS TEETER', 'WHOLEFDS',
  'SUNSHINE SPIRITS', 'LOWCOUNTRY WINE', 'PLANET VAPE', 'ROOMS TO GO',
  'SYNCHRONY', 'COASTAL MARINAS',
];

// PAYOREXPRESSCC rows are online card payments drawn on Easy Business
// Checking - a liability paydown like Amex, not an expense.
const RE_CREDIT_CARD_PAYMENT = /AMEX EPAYMENT|PAYOREXPRESSCC/i;
const RE_LOC_PAYMENT = /Lendica/i;
// "ACH Withdrawal IRS" rows on 6731 are the same prior-year personal
// liability paid through bill pay instead of Direct Pay.
const RE_TAX_PAYMENT = /IRS - USATAXPYMT|ACH Withdrawal IRS\b/i;
const RE_MORTGAGE = /ROCKET MORTGAGE|LOANDEPOT/i;
// Matches both "Deere Credit" (spelled out) and the "Deere Credt" shorthand
// seen on a couple of rows.
// Geneva Capital is equipment finance (single $11,846.69 payment, 2025).
// Same lump-sum treatment as Deere until a principal/interest schedule
// arrives. The underlying asset is a Section 179 / bonus-depreciation
// candidate - see exports and the write-off report.
const RE_EQUIPMENT_LOAN = /DEERE CRED|GENEVA CAPITAL/i;
// "(Returned)AMEX EPAYMENT..." / "Insufficient Funds Charge ...AMEX EPAYMENT"
// rows are NSF bank fees that just NAME the payment that bounced - they are
// not a card payment themselves and fall through to the normal account
// default (a real bank fee is a legitimate 6723 business expense).
const RE_NSF_FEE = /Insufficient Funds Charge/i;

const RE_HEALTH_INSURANCE = /UNITEDHEALTHCARE|BCBS/i;

// Bank penalty fees (NSF, uncollected funds, check overdraft). On the
// business accounts these are deductible bank charges. Checked BEFORE the
// merchant patterns below because the fee row NAMES the payee that bounced
// ("Insufficient Funds Charge ... STARLINK") and would otherwise be
// swallowed by that payee's rule - same trap the NSF/UnitedHealthcare bug
// documented above.
const RE_BANK_PENALTY = /Insufficient Funds Charge|Uncollected Funds Charge|OVERDRAFT FEE/i;

// The account's own overdraft-protection pull showing up as a credit on
// 6731. It is the inbound leg of an internal top-up, not income.
const RE_OD_PROTECTION = /Overdraft Protection Deposit/i;

// Home utilities paid from the business bill-pay account. Not deductible
// as-is; they are the raw material for a home-office percentage, so they
// go to PERSONAL with a note instead of silently joining the distribution.
const RE_HOME_UTILITY = /ST JOHNS WATER|BERKELEY ELEC/i;

// Starlink on a builder's bill-pay account is job-site/office internet -
// same treatment as the OpenPhone/Mint Mobile lines already in BUSINESS.
const RE_STARLINK = /STARLINK/i;

// Business spend that was landing in PERSONAL or REVIEW by account default.
// Builders FirstSource and All Seasons Mulch are job materials, Carolina
// Waste is disposal (same trade as Trident Waste, already BUSINESS),
// Accreditation Services is licensing (8 level monthly payments), and the
// 6731 Home Depot ACH rows are the same merchant already whitelisted on
// 6715.
const BUSINESS_REFILE = [
  'BUILDERSFIRSTSO', 'ALL SEASONS MUL', 'CAROLINA WASTE', 'ACCREDITATION S',
  'HOME DEPOT',
];

// Repeated Venmo/Wave payments to non-family workers. Cesar (12 payments,
// two spellings) and Oleksandr are labor patterns, HangTen is a paid
// invoice via Wave. Deductible subcontractor cost - flagged for W-9/1099
// in the review note, NOT silently clean. Family Venmo (Stacey, Cheryl,
// Lindsey) is deliberately absent: those stay PERSONAL.
const SUB_PAY_PATTERNS = ['VENMO * CESAR', 'VENMO * OLEKSAND', 'WAVE * HANGTEN'];
// PROG DIRECT is Progressive's short descriptor on 6731 bill-pay rows.
// MW Premium Finance is commercial-insurance premium financing - the
// financed premiums are the deductible, same bucket.
const RE_INSURANCE = /PROGRESSIVE|PROG DIRECT|COMMERCIAL INSU|OBSIDIAN|MUNRO|MWPREMIUMFINANCE/i;

const RE_ZELLE = /\bZelle\b/i;

// Substring match against the extracted sender, uppercased. Both name orders
// appear in the data ("MONAGHAN CHERYL" on the Jan row, "CHERYL MONAGHAN"
// after, "STACEY MCGILLIS" without the "-Evans"), so match on surname.
// Ryley's decision 2026-08-19, superseding the 2026-08-18 RELATED_PARTY bucket:
// every Zelle inflow from Cheryl Monaghan is a GIFT (not income, not a related-
// party receipt), and every Zelle inflow from Stacey McGillis is REVENUE. The
// bucket therefore holds one surname, and McGillis moves to the customer list.
const GIFT_SENDERS = ['MONAGHAN'];

// Confirmed customers, per Ryley 2026-08-18. Corroborating evidence found the
// same day: Bruce Matt appears on the OAB task board ("Bruce Matt - permits",
// job General/Office, completed by RM); Abigail Smith appears in OAB customer
// email carrying a $200 assessment fee and a $720 labor charge. Rose Dodson
// and James J Dye were confirmed by Ryley directly - no document trail exists
// in the searchable record, which starts after these 2025 transfers.
// These are gross receipts.
// MCGILLIS is a bare surname on purpose: the statements carry "STACEY MCGILLIS"
// but the legal name is McGillis-Evans, so a full-name key would miss any row
// that spells it out. Ryley reclassified her from related party to customer on
// 2026-08-19.
const CUSTOMER_ZELLE_SENDERS = ['BRUCE MATT', 'ABIGAIL SMITH', 'ROSE DODSON', 'JAMES J DYE', 'MCGILLIS'];

// Subcontractors who sent money BACK. Ryley confirmed 2026-08-18 that OAB paid
// Chetos Concrete as a sub in 2025, so this $300 inflow is a refund, credit, or
// returned deposit. Booking it as revenue would inflate gross receipts AND
// leave the subcontractor expense overstated by the same $300.
const SUB_REFUND_SENDERS = ['CHETOS'];

// Names arrive in either order across statements ("MONAGHAN CHERYL" in January,
// "CHERYL MONAGHAN" every row after), so an exact-string match is not safe.
// Compare on the sorted token set, and fall back to substring for entity names
// whose suffix varies ("Chetos Concrete Construction Llc" vs. "Chetos").
const nameKey = s =>
  (s || '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
const senderMatches = (sender, list) => {
  if (!sender) return false;
  const key = nameKey(sender);
  const upper = sender.toUpperCase();
  return list.some(n => key === nameKey(n) || upper.includes(n));
};

// "NOW Deposit Zelle From STACEY MCGILLIS +1-800-845-0432"
// "(no description) ZELLE FROM MONAGHAN CHERYL REF# 250118D0J2Q8"
// "...Zelle From ABIGAIL SMITH +1-800-845-0432 -- 2 of 10 -- Easy Business
//  Checking - XXXXXX6715 (continued)"   <- page-break tail must be stripped
// Returns null when the description has no parseable sender.
const RE_ZELLE_SENDER = /Zelle\s+From\s+(.+?)(?:\s*\+\d|\s+REF#|\s+--|\s*$)/i;
function extractZelleSender(description) {
  const m = RE_ZELLE_SENDER.exec(description || '');
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}
const RE_REVENUE = /\b(Deposit|Wire)\b/i;
// A "Deposit"/"Wire" match can still be a transfer, an overdraft-protection
// self-refund, or a bounced/reversed item rather than real income - all of
// which also contain those words. None of these are gross receipts.
const RE_REVENUE_EXCLUDE = /TFR|Overdraft|Rejected|Revers/i;

const matchesAny = (desc, list) => {
  const upper = (desc || '').toUpperCase();
  return list.find(v => upper.includes(v)) || null;
};

// Returns an array of { category, label, amount, reviewNote? } splits -
// almost always one entry, two only for loan payments (principal + interest).
function categorizeTransaction(tx, accountNumber) {
  if (tx.principal != null) {
    return [
      { category: 'LOAN_PRINCIPAL', label: 'Loan Principal', amount: tx.principal },
      { category: 'BUSINESS', label: 'Interest Expense', amount: tx.interest },
    ];
  }

  const amount = Math.abs(tx.amount);
  const d = tx.description || '';

  if (tx.transferTag === 'INTERNAL_TRANSFER') {
    return [{ category: 'INTERNAL_TRANSFER', label: 'Internal Transfer', amount }];
  }
  if (tx.transferTag === 'EXTERNAL_INBOUND' || tx.transferTag === 'EXTERNAL_OUTBOUND') {
    return [{ category: 'REVIEW', label: tx.transferTag, amount }];
  }

  if (accountNumber === '6600') {
    return [{ category: 'EXCLUDE', label: 'Dormant Account', amount }];
  }

  if (RE_BANK_PENALTY.test(d) && (accountNumber === '6723' || accountNumber === '6731')) {
    return [{ category: 'BUSINESS', label: 'Bank Fees (NSF/overdraft/uncollected)', amount }];
  }
  if (RE_OD_PROTECTION.test(d) && tx.type === 'credit') {
    return [{ category: 'EXCLUDE', label: 'Overdraft protection self-transfer', amount }];
  }

  if (RE_CREDIT_CARD_PAYMENT.test(d) && !RE_NSF_FEE.test(d)) {
    return [{ category: 'CREDIT_CARD_PAYMENT', label: 'Credit Card Payment', amount }];
  }
  if (RE_LOC_PAYMENT.test(d)) {
    return [{
      category: 'LOC_PAYMENT', label: 'Line of Credit Payment', amount,
      reviewNote: 'LOC_PAYMENT recorded as a lump sum - no fee schedule yet to split principal vs fee.',
    }];
  }
  if (RE_TAX_PAYMENT.test(d)) {
    return [{ category: 'TAX_PAYMENT', label: 'Tax Payment (prior-year personal)', amount }];
  }
  if (RE_MORTGAGE.test(d)) {
    return [{ category: 'MORTGAGE', label: 'Mortgage Payment', amount }];
  }
  if (RE_EQUIPMENT_LOAN.test(d)) {
    return [{
      category: 'EQUIPMENT_LOAN', label: 'Equipment Loan (Deere Credit)', amount,
      reviewNote: 'EQUIPMENT_LOAN recorded as a lump sum - statement showing the principal/interest split hasn\'t arrived yet.',
    }];
  }

  if (RE_HEALTH_INSURANCE.test(d)) {
    return [{ category: 'HEALTH_INSURANCE', label: 'Health Insurance (UnitedHealthcare/BCBS)', amount }];
  }
  if (RE_INSURANCE.test(d)) {
    return [{ category: 'INSURANCE', label: 'Insurance (Progressive/Munro/Commercial/Obsidian/MW)', amount }];
  }

  if (RE_STARLINK.test(d)) {
    return [{ category: 'BUSINESS', label: 'Business (STARLINK internet)', amount }];
  }
  if (RE_HOME_UTILITY.test(d)) {
    return [{
      category: 'PERSONAL', label: `Personal (home utility)`, amount,
      reviewNote: 'Home utility paid from business account. Not deductible directly - counts toward a home-office percentage if one is claimed.',
    }];
  }
  // Home Depot CARD payments (ONLINE PMT / bare ACH) are distinct from
  // store purchases: the deduction is really for the materials charged on
  // the card, so the card statements are the substantiation. A Home Depot
  // store card can only buy Home Depot goods, which for this trade is
  // materials - unlike Amex, whose payments stay excluded as unknowable.
  if (/HOME DEPOT.*ONLINE PMT|ACH Withdrawal HOME DEPOT/i.test(d) && tx.type !== 'credit') {
    return [{
      category: 'BUSINESS', label: 'Business (HOME DEPOT card pmt - materials)', amount,
      reviewNote: 'Home Depot card payment deducted as materials. Keep the card statements - they are the substantiation, and any non-job purchase on the card must come back out.',
    }];
  }
  {
    const refileHit = matchesAny(d, BUSINESS_REFILE);
    if (refileHit && tx.type !== 'credit') {
      return [{ category: 'BUSINESS', label: `Business (${refileHit})`, amount }];
    }
    const subHit = matchesAny(d, SUB_PAY_PATTERNS);
    if (subHit && tx.type !== 'credit') {
      return [{
        category: 'BUSINESS', label: `Business (Sub labor - ${subHit})`, amount,
        reviewNote: 'Subcontractor paid by Venmo/Wave. Deductible, but collect a W-9 and file a 1099-NEC if 2025 payments to this person exceed $600.',
      }];
    }
  }

  if ((accountNumber === '6715' || accountNumber === '6723') && tx.type === 'credit') {
    if (RE_ZELLE.test(d) && !RE_REVENUE_EXCLUDE.test(d)) {
      const sender = extractZelleSender(d);
      const upper = (sender || '').toUpperCase();
      const isGift = sender && GIFT_SENDERS.some(n => upper.includes(n));
      if (isGift) {
        return [{ category: 'GIFT', label: `Gift (Zelle - ${sender})`, amount, zelleSender: sender }];
      }
      if (senderMatches(sender, CUSTOMER_ZELLE_SENDERS)) {
        return [{ category: 'REVENUE', label: `Gross Receipts (Zelle - ${sender})`, amount, zelleSender: sender }];
      }
      if (senderMatches(sender, SUB_REFUND_SENDERS)) {
        return [{
          category: 'BUSINESS_REFUND',
          label: `Subcontractor Refund (Zelle - ${sender})`,
          amount,
          zelleSender: sender,
        }];
      }
      return [{
        category: 'ZELLE_UNKNOWN_SENDER',
        label: `Zelle - unknown sender (${sender || 'unparsed'})`,
        amount,
        zelleSender: sender,
        reviewNote: `Zelle credit from "${sender || 'unparsed sender'}" - not a known related party. Confirm customer payment (gross receipts) vs. gift/loan before filing.`,
      }];
    }
    if (RE_REVENUE.test(d) && !RE_REVENUE_EXCLUDE.test(d)) {
      return [{ category: 'REVENUE', label: 'Gross Receipts', amount }];
    }
  }

  const personalHit = matchesAny(d, KNOWN_PERSONAL);

  if (accountNumber === '6715') {
    if (personalHit) return [{ category: 'PERSONAL', label: `Personal (${personalHit})`, amount }];
    const bizHit = matchesAny(d, WHITELIST_6715);
    if (bizHit) return [{ category: 'BUSINESS', label: `Business (${bizHit})`, amount }];
    return [{ category: 'PERSONAL', label: 'Personal (default)', amount }];
  }

  if (accountNumber === '6723') {
    // Ryley 2026-08-19: personal-looking spend from the operating account IS
    // personal - groceries, liquor, dating apps and the marina do not go to
    // a human review queue, they go straight to the distribution tally.
    if (personalHit) return [{ category: 'PERSONAL', label: `Personal (${personalHit})`, amount }];
    return [{ category: 'BUSINESS', label: 'Business (6723 operating)', amount }];
  }

  if (accountNumber === '6731') {
    if (personalHit) return [{ category: 'PERSONAL', label: `Personal (${personalHit})`, amount }];
    return [{ category: 'REVIEW', label: 'Draws account (default)', amount }];
  }

  return [{ category: 'REVIEW', label: 'Unmapped account', amount }];
}

module.exports = {
  categorizeTransaction, WHITELIST_6715, KNOWN_PERSONAL,
  GIFT_SENDERS, CUSTOMER_ZELLE_SENDERS, SUB_REFUND_SENDERS,
  extractZelleSender, senderMatches,
};
