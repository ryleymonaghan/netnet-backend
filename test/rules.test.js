const test = require('node:test');
const assert = require('node:assert');
const { applyRules, extractZelleSender, lookupSender } = require('../lib/rules');

const tx = (description, amount, type) => ({ description, amount, type });

test('internal transfers never reach the ledger', () => {
  for (const d of [
    'Deposit TFR FRM CHECKG x6723',
    'ONLINE TRANSFER TO SAVINGS 1234',
    'Transfer From Money Market',
    'XFER TO CHECKING',
  ]) {
    const r = applyRules(tx(d, 10000, 'credit'));
    assert.strictEqual(r.category, 'EXCLUDED', d);
    assert.strictEqual(r.subcategory, 'Internal Transfer');
  }
});

test('reversals beat every other pattern', () => {
  // Contains BOTH "Deposit" and "Revers" — the reversal must win, or a bounced
  // deposit is booked as revenue.
  const r = applyRules(tx('Deposit Reversal ACH CO NAME', 5000, 'credit'));
  assert.strictEqual(r.category, 'EXCLUDED');
  assert.strictEqual(r.subcategory, 'Reversed / Returned');
});

test('overdraft protection is not income', () => {
  const r = applyRules(tx('Overdraft Protection Transfer', 500, 'credit'));
  assert.strictEqual(r.category, 'EXCLUDED');
});

test('an unknown Zelle sender ABSTAINS — it does not guess revenue', () => {
  const r = applyRules(tx('NOW Deposit Zelle From BRUCE MATT +1-800-845-0432', 15000, 'credit'));
  assert.strictEqual(r.category, 'NEEDS_REVIEW');
  assert.strictEqual(r.needs_review, true);
  // A null confidence, never a low number. A low number invites a threshold to
  // promote it; null cannot be compared into acceptance.
  assert.strictEqual(r.confidence, null);
  assert.match(r.notes, /BRUCE MATT/);
});

test('a classified sender resolves without an API call', () => {
  const ctx = { knownSenders: [
    { name: 'Bruce Matt',      classification: 'REVENUE', note: 'permits pulled 2025' },
    { name: 'Cheryl Monaghan', classification: 'CAPITAL_CONTRIBUTION' },
    { name: 'Chetos',          classification: 'PERSONAL' },
  ]};
  const rev = applyRules(tx('Zelle From BRUCE MATT +1-800', 15000, 'credit'), ctx);
  assert.strictEqual(rev.category, 'REVENUE');
  assert.strictEqual(rev.tax_treatment, 'revenue');
  assert.match(rev.notes, /permits pulled 2025/);

  // Partner capital is NOT revenue and NOT a gift — its own treatment.
  const cap = applyRules(tx('ZELLE FROM MONAGHAN CHERYL REF# 250118D0J2Q8', 2000, 'credit'), ctx);
  assert.strictEqual(cap.category, 'CAPITAL & ASSETS');
  assert.strictEqual(cap.subcategory, 'Partner Capital Contribution');
});

test('sender matching survives reversed name order and entity suffixes', () => {
  const ctx = { knownSenders: [{ name: 'Cheryl Monaghan', classification: 'GIFT' }] };
  // Both spellings appear in real statements and must resolve to one person.
  for (const d of ['Zelle From CHERYL MONAGHAN', 'ZELLE FROM MONAGHAN CHERYL REF# 1']) {
    assert.strictEqual(applyRules(tx(d, 2000, 'credit'), ctx).category, 'EXCLUDED', d);
  }
  const llc = { knownSenders: [{ name: 'Chetos', classification: 'REVENUE' }] };
  assert.strictEqual(
    applyRules(tx('Zelle From Chetos Concrete Construction Llc', 300, 'credit'), llc).category,
    'REVENUE');
});

test('a Zelle DEBIT is not treated as an inbound payment', () => {
  // Money going out over the same rail must not hit the inbound sender logic.
  const r = applyRules(tx('Zelle To A SUPPLIER', -800, 'debit'));
  assert.strictEqual(r, null, 'should fall through to the model, not abstain as a credit');
});

test('loan payments abstain rather than deduct the whole payment', () => {
  const r = applyRules(tx('DEERE CREDIT EQUIPMENT LOAN PMT', -1482.19, 'debit'));
  assert.strictEqual(r.category, 'NEEDS_REVIEW');
  assert.match(r.notes, /[Pp]rincipal/);
});

test('ordinary merchant rows defer to the model', () => {
  for (const d of ['BUCK LUMBER & BUILDING SUPPLY', 'SHELL OIL 574839201', 'HOME DEPOT #1204']) {
    assert.strictEqual(applyRules(tx(d, -300, 'debit')), null, d);
  }
});

test('sign convention is trusted from type, not guessed from amount', () => {
  // Some exports write every amount positive and carry direction in `type`.
  const r = applyRules(tx('Zelle From SOMEONE NEW', 500, 'credit'));
  assert.strictEqual(r.category, 'NEEDS_REVIEW');
  const noType = applyRules({ description: 'Zelle From SOMEONE NEW', amount: 500 });
  assert.strictEqual(noType.category, 'NEEDS_REVIEW');
});

test('extractZelleSender strips phone numbers, refs and page-break tails', () => {
  assert.strictEqual(extractZelleSender('Zelle From ABIGAIL SMITH +1-800-845-0432 -- 2 of 10 --'), 'ABIGAIL SMITH');
  assert.strictEqual(extractZelleSender('ZELLE FROM MONAGHAN CHERYL REF# 250118D0J2Q8'), 'MONAGHAN CHERYL');
  assert.strictEqual(extractZelleSender('HOME DEPOT #1204'), null);
});

test('lookupSender returns null rather than a loose match', () => {
  const known = [{ name: 'Bruce Matt', classification: 'REVENUE' }];
  assert.strictEqual(lookupSender('Bruce Wayne', known), null);
  assert.strictEqual(lookupSender(null, known), null);
  assert.strictEqual(lookupSender('Bruce Matt', undefined), null);
});

test('a refund from a sub reduces expense — it is never revenue', () => {
  const ctx = { knownSenders: [{ name: 'Chetos', classification: 'SUB_REFUND' }] };
  const r = applyRules(tx('Zelle From Chetos Concrete Construction Llc', 300, 'credit'), ctx);
  assert.strictEqual(r.category, 'COGS');
  assert.strictEqual(r.subcategory, 'Subcontractor Refund');
  assert.notStrictEqual(r.category, 'REVENUE');
});

test('an NSF FEE is a bank charge, not a reversal and not insurance', () => {
  // Live regression: the model booked this exact row as
  // FIXED EXPENSES / Insurance (GL Workers Comp E&O) because of the vendor name.
  const r = applyRules(tx('NSF FEE UNITEDHEALTHCARE', -36.00, 'debit'));
  assert.strictEqual(r.category, 'CONTROLLABLE EXPENSES');
  assert.strictEqual(r.subcategory, 'Bank Fees');
  assert.strictEqual(r.write_off, true);
});

test('an NSF RETURN is still excluded — the fee rule must not swallow it', () => {
  const r = applyRules(tx('NSF Return Item ACH DEBIT', -1200, 'debit'));
  assert.strictEqual(r.category, 'EXCLUDED');
  assert.strictEqual(r.subcategory, 'Reversed / Returned');
});

test('a loan transfer is a loan question, not a silent transfer exclusion', () => {
  // "Electronic Transfer TFR TO LOAN" matches BOTH transfer and loan. Live data
  // had two of these deducted in full as FIXED EXPENSES / Loan Payments.
  const r = applyRules(tx('Electronic Transfer TFR TO LOAN #######66-21', -410.98, 'debit'));
  assert.notStrictEqual(r, null);
  assert.ok(r.category === 'EXCLUDED' || r.category === 'NEEDS_REVIEW');
});
