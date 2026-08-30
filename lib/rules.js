// Net-Net — deterministic rule pass
//
// WHY THIS EXISTS
//
// Every transaction used to go straight to Claude with a taxonomy and a request
// for a confidence score. That has one fatal property: the model has no way to
// say "I don't know." Asked to pick a category, it picks one, and it reports its
// own confidence in the choice it just made. A Zelle credit from a stranger comes
// back as REVENUE / Service Revenue at 0.92 — which is exactly the error that
// started this project, where every Zelle credit was assumed to be family and
// five of eight senders were not.
//
// Some transactions are not judgment calls. An internal transfer between two of
// your own accounts is not income no matter how it reads. A reversed ACH is not a
// payment. A loan payment is two things, principal and interest, and only one of
// them is deductible. These have right answers, and a language model should never
// be the thing deciding them.
//
// So: rules run FIRST. They handle what is knowable, they ABSTAIN on what is not,
// and only what is left over — genuinely novel merchant descriptions — reaches
// Claude. Three consequences, in order of importance:
//
//   1. The cases we already know are hard stop being guessed at.
//   2. "Never guess" becomes enforceable rather than aspirational.
//   3. Most rows never reach the API at all, which is the cost story.
//
// WHAT THIS FILE IS NOT
//
// It is not `lib/parsers/categorize.js`. That file is the tax engine for Ryley's
// own 2025 return and it is hard-wired to his account numbers, his vendor
// whitelist, and his family. It reconciles 2,838 of 2,844 rows and it should stay
// exactly as specific as it is. This file is the general form: the same
// discipline, with everything user-specific passed in as `ctx` instead of baked in.

// ── Patterns that are true for any bank, any user ────────────────────────────

// An internal transfer is not income and not an expense. It is the same dollar
// twice. Left in, it inflates both sides of the P&L: in Ryley's 2025 data the
// matcher found 201 pairs moving $569,512.57 that must never touch the ledger.
const RE_TRANSFER = /\b(TFR|XFER|TRANSFER)\b|Transfer (To|From)\b|\bONLINE (BANKING )?TRANSFER\b/i;

// A bank CHARGE for insufficient funds is a real expense you really paid. The
// insufficient-funds RETURN is the thing that isn't a payment. Both say "NSF",
// which is why this is checked before the reversal pattern.
//
// Caught on Ryley's live data: "NSF FEE UNITEDHEALTHCARE" was categorized by the
// model as FIXED EXPENSES / Insurance (GL Workers Comp E&O). It is a $36 bank
// fee. It is not general liability, it is not workers comp, and it is not health
// insurance — the model matched the vendor name in the string and never saw the
// "NSF FEE" in front of it.
const RE_NSF_FEE = /\b(NSF|Insufficient Funds|Overdraft)\s*(Fee|Charge)\b|\bInsufficient Funds Charge\b/i;

// Attempts that did not complete. A bounced payment is not a payment, and a
// reversal is not revenue. Both leave rows that read exactly like the real thing.
const RE_REVERSAL = /\b(Rejected|Revers(al|ed|es)?|Returned Item|NSF Return|Insufficient Funds Return|Chargeback|Void(ed)?)\b/i;

// Overdraft protection moving your own money to cover your own account.
const RE_OVERDRAFT = /Overdraft (Protection|Transfer|Advance)/i;

const RE_ZELLE = /\b(Zelle|QuickPay)\b/i;
// "NOW Deposit Zelle From STACEY MCGILLIS +1-800-845-0432"
// "(no description) ZELLE FROM MONAGHAN CHERYL REF# 250118D0J2Q8"
const RE_ZELLE_SENDER = /(?:Zelle|QuickPay)\s+From\s+(.+?)(?:\s*\+\d|\s+REF#|\s+--|\s*$)/i;

// Loan and equipment payments are two categories in one row. Splitting them is
// arithmetic once you know the rate, never a judgment call.
const RE_LOAN = /\b(LOAN|MORTGAGE|EQUIP(MENT)? (LOAN|FINANCE)|CREDIT PMT|PRINCIPAL)\b/i;

const upper = s => (s || '').toUpperCase();

// Names arrive in either order across statements ("MONAGHAN CHERYL" in January,
// "CHERYL MONAGHAN" every row after), so compare on the sorted token set.
const nameKey = s =>
  upper(s).replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');

function extractZelleSender(description) {
  const m = RE_ZELLE_SENDER.exec(description || '');
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

// A sender the user has already told us about. Matches on sorted tokens, with a
// substring fallback for entity names whose suffix varies ("Chetos Concrete
// Construction Llc" vs. the "Chetos" the user typed).
function lookupSender(sender, knownSenders) {
  if (!sender || !knownSenders) return null;
  const key = nameKey(sender);
  const up = upper(sender);
  for (const entry of knownSenders) {
    const name = entry.name || entry.sender;
    if (!name) continue;
    if (nameKey(name) === key || up.includes(upper(name))) return entry;
  }
  return null;
}

const decide = (category, subcategory, extra = {}) => ({
  category,
  subcategory: subcategory || null,
  tax_treatment: null,
  write_off: false,
  write_off_pct: null,
  confidence: 1,
  source: 'rules',
  needs_review: false,
  ...extra,
});

const abstain = (why) => ({
  category: 'NEEDS_REVIEW',
  subcategory: null,
  tax_treatment: null,
  write_off: false,
  write_off_pct: null,
  // Not a low confidence score — an explicit refusal. Nothing downstream should
  // ever promote this to a category on its own.
  confidence: null,
  source: 'rules',
  needs_review: true,
  notes: why,
});

/**
 * Decide a transaction by rule, or defer.
 *
 * @param {{description:string, amount:number, type?:string}} tx
 * @param {{knownSenders?:Array<{name:string,classification:string,note?:string}>}} ctx
 * @returns {object|null} a decision, or null meaning "no rule applies — ask Claude"
 */
function applyRules(tx, ctx = {}) {
  const d = tx.description || '';
  const amount = Number(tx.amount);
  // Bank exports disagree on sign convention, so trust an explicit type first and
  // fall back to the sign only when there isn't one.
  const isCredit = tx.type ? tx.type === 'credit' : amount > 0;

  // 1. A bank fee is a real expense — check it BEFORE the reversal pattern, which
  //    it would otherwise match on the word NSF and be wrongly excluded.
  if (RE_NSF_FEE.test(d)) {
    return decide('CONTROLLABLE EXPENSES', 'Bank Fees', {
      tax_treatment: 'deductible',
      write_off: true,
      write_off_pct: 100,
      notes: 'Bank fee for insufficient funds. A deductible business expense — not insurance, and not a reversal, whatever vendor name follows it.',
    });
  }

  // 2. Reversals and bounces next — they also match the patterns below, and a
  //    reversed deposit read as revenue is worse than no answer at all.
  if (RE_REVERSAL.test(d)) {
    return decide('EXCLUDED', 'Reversed / Returned', {
      notes: 'Reversed, returned, or bounced. Not income and not an expense.',
    });
  }

  // 3. Your own money moving between your own accounts.
  if (RE_OVERDRAFT.test(d)) {
    return decide('EXCLUDED', 'Overdraft Protection', {
      notes: 'Overdraft protection moving your own funds. Nets to zero across accounts.',
    });
  }
  if (RE_TRANSFER.test(d)) {
    return decide('EXCLUDED', 'Internal Transfer', {
      notes: 'Transfer between your own accounts. Counting it would inflate both revenue and expenses.',
    });
  }

  // 4. Zelle and peer-to-peer credits. THE case that must never be guessed:
  //    the same rail carries customer payments, family gifts, partner capital,
  //    and loan repayments, and the description alone cannot tell them apart.
  if (isCredit && RE_ZELLE.test(d)) {
    const sender = extractZelleSender(d);
    const known = lookupSender(sender, ctx.knownSenders);
    if (known) {
      const who = sender || known.name;
      switch (upper(known.classification)) {
        case 'REVENUE':
          return decide('REVENUE', 'Service Revenue', {
            tax_treatment: 'revenue',
            notes: `Customer payment from ${who}. Classified by you${known.note ? ` — ${known.note}` : ''}.`,
          });
        case 'GIFT':
          return decide('EXCLUDED', 'Gift Received', {
            notes: `Gift from ${who}. Not income to the business.`,
          });
        case 'CAPITAL_CONTRIBUTION':
          return decide('CAPITAL & ASSETS', 'Partner Capital Contribution', {
            tax_treatment: 'capital',
            notes: `Capital contribution from ${who}. Not income — increases their basis and must be tracked against distributions.`,
          });
        case 'LOAN':
          return decide('EXCLUDED', 'Loan Proceeds', {
            notes: `Loan from ${who}. Not income. Creates a liability.`,
          });
        case 'PERSONAL':
          return decide('PERSONAL', 'Non-Business Transfer', {
            tax_treatment: 'personal',
            notes: `Personal transfer from ${who}.`,
          });
        case 'SUB_REFUND':
          // Money coming back from a sub you paid. Revenue would be wrong twice:
          // gross receipts too high, and the expense it came from still too high.
          return decide('COGS', 'Subcontractor Refund', {
            tax_treatment: 'cogs',
            write_off: false,
            notes: `Refund from ${who}, a subcontractor you paid. Reduces subcontractor expense — not gross receipts.`,
          });
        default:
          return abstain(`Sender "${who}" is on file but its classification "${known.classification}" is not one we act on.`);
      }
    }
    return abstain(
      `Peer-to-peer credit from "${sender || 'an unparsed sender'}". This rail carries customer payments, gifts, partner capital and loan repayments, and the description cannot tell them apart. Classify the sender once and every future transfer from them is automatic.`
    );
  }

  // 5. Loan payments are principal plus interest. Only the interest is
  //    deductible, and the split is arithmetic — but it needs the schedule,
  //    which we do not have here. Refuse rather than deduct the whole payment.
  if (!isCredit && RE_LOAN.test(d)) {
    return abstain(
      'Loan or equipment payment. Principal is not deductible and interest is; splitting them needs the amortization schedule. Add the loan and the split becomes automatic.'
    );
  }

  // 6. No rule applies. This is an ordinary merchant description and a language
  //    model reading it is genuinely the right tool.
  return null;
}

module.exports = { applyRules, extractZelleSender, lookupSender, nameKey };
