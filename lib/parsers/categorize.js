// Category engine + account default matrix (NETNET_PARSER_SPEC.md). Every
// reconciled, non-transfer transaction gets a category before it can enter
// the P&L or the distribution tally.
//
// Precedence, checked in this order:
//   1. Loan payments (tx.principal != null) always split into principal
//      (EXCLUDE - a balance-sheet paydown, not an expense) and interest
//      (BUSINESS - a real deductible expense). This runs BEFORE the
//      transferTag check below: lib/parsers/transfers.js tags the loan's
//      own "Regular Payment" row INTERNAL_TRANSFER too (it's genuinely the
//      inbound leg of the checking account's outbound transfer, fund-flow
//      wise), but categorizing the whole row that way would silently
//      erase the real interest expense. The checking side's OUTBOUND leg
//      of that same transfer has no .principal field, so it falls through
//      to the transferTag check normally and is correctly excluded there -
//      only the loan's own record needs the split.
//   2. INTERNAL_TRANSFER / EXTERNAL_INBOUND / EXTERNAL_OUTBOUND (tagged by
//      transfers.js) - external ones go to the review queue for manual
//      classification; internal ones are excluded outright.
//   3. Account 6600: EXCLUDE unconditionally (dormant, transfers only).
//   4. Known-personal merchant patterns force PERSONAL - except on 6723,
//      the primary operating account, where a personal-looking charge is
//      flagged for REVIEW instead of auto-classified (per the spec's
//      account matrix: "Flag personal for review").
//   5. Account defaults: 6715 PERSONAL unless on the business whitelist,
//      6723 BUSINESS, 6731 REVIEW.
const WHITELIST_6715 = [
  'BUCK LUMBER', 'BUILDERSFIRSTSOURCE', "LOWE'S", 'HOME DEPOT', 'TRACTOR SUPPLY',
  'SHERWIN-WILLIAMS', 'HARBOR FREIGHT', 'ALL SEASONS HARDWARE', 'SITEONE',
  'GUSTO', 'ADP', 'INTUIT', 'QUICKBOOKS', 'DOCUSIGN', 'PROPOSIFY', 'JOIST', 'CANVA',
  'ADOBE', 'OPENPHONE', 'BILLER GENIE', 'MERCHANT BANKCD', 'SURFERSEO', 'BLUEHOST',
  'GODADDY', 'MICROSOFT', 'GOOGLE ADS', 'TRIDENT WASTE', 'STARLINK', 'MINT MOBILE',
  'A & R SHEET METAL', 'ISLAND SEPTIC', 'COASTAL MARINAS',
];

const KNOWN_PERSONAL = [
  'NETFLIX', 'DISNEY PLUS', 'PEACOCK', 'PARAMOUNT+', 'SLING', 'TINDER', 'BUMBLE',
  'ONLYFANS', 'CCBILL', 'SEEKING', 'WINGMAN', 'PURE ANONYMOU', 'ZEDGE',
  'STONO LIQUORS', 'FOOD LION', 'PUBLIX', 'HARRIS TEETER', 'WHOLEFDS',
  'SUNSHINE SPIRITS', 'LOWCOUNTRY WINE', 'PLANET VAPE', 'ROOMS TO GO',
  'SYNCHRONY', 'ROCKET MORTGAGE', 'LOANDEPOT', 'IRS - USATAXPYMT',
];

const matchesAny = (desc, list) => {
  const upper = (desc || '').toUpperCase();
  return list.find(v => upper.includes(v)) || null;
};

// Returns an array of { category, label, amount } splits - almost always
// one entry, two only for loan payments (principal + interest).
function categorizeTransaction(tx, accountNumber) {
  if (tx.principal != null) {
    return [
      { category: 'EXCLUDE', label: 'Loan Principal', amount: tx.principal },
      { category: 'BUSINESS', label: 'Interest Expense', amount: tx.interest },
    ];
  }

  const amount = Math.abs(tx.amount);

  if (tx.transferTag === 'INTERNAL_TRANSFER') {
    return [{ category: 'INTERNAL_TRANSFER', label: 'Internal Transfer', amount }];
  }
  if (tx.transferTag === 'EXTERNAL_INBOUND' || tx.transferTag === 'EXTERNAL_OUTBOUND') {
    return [{ category: 'REVIEW', label: tx.transferTag, amount }];
  }

  if (accountNumber === '6600') {
    return [{ category: 'EXCLUDE', label: 'Dormant Account', amount }];
  }

  const personalHit = matchesAny(tx.description, KNOWN_PERSONAL);

  if (accountNumber === '6715') {
    if (personalHit) return [{ category: 'PERSONAL', label: `Personal (${personalHit})`, amount }];
    const bizHit = matchesAny(tx.description, WHITELIST_6715);
    if (bizHit) return [{ category: 'BUSINESS', label: `Business (${bizHit})`, amount }];
    return [{ category: 'PERSONAL', label: 'Personal (default)', amount }];
  }

  if (accountNumber === '6723') {
    if (personalHit) return [{ category: 'REVIEW', label: `Looks personal (${personalHit})`, amount }];
    return [{ category: 'BUSINESS', label: 'Business (6723 operating)', amount }];
  }

  if (accountNumber === '6731') {
    if (personalHit) return [{ category: 'PERSONAL', label: `Personal (${personalHit})`, amount }];
    return [{ category: 'REVIEW', label: 'Draws account (default)', amount }];
  }

  return [{ category: 'REVIEW', label: 'Unmapped account', amount }];
}

module.exports = { categorizeTransaction, WHITELIST_6715, KNOWN_PERSONAL };
