# Net-Net — SC Federal Statement Parser
## Claude Code Session Spec
### v1.0 — build target: `netnet-backend/lib/parsers/scfederal.js`

---

## SESSION START

```bash
cd ~/Desktop/Repos/netnet-backend && claude
```

Upload this file at session start.

---

## WHY THIS EXISTS

Net-Net's current importer produces plausible-looking but wrong output on South
Carolina Federal Credit Union statements. Root cause identified 2026-08-16:

**SC Federal changed their statement layout mid-2025. A single set of statements
for one calendar year contains two different formats.**

A parser built against one variant silently drops or mis-signs transactions from
the others. Because the output still looks like a transaction list, nothing fails
loudly — it just produces a wrong P&L.

This is the same silent-failure class as the retired Claude model ID and the
disabled Supabase key. Fail loud, not quiet.

---

## GROUND TRUTH TEST FIXTURE

Real 2025 data, 4 accounts + 1 loan, 12 statements, ~2,830 transactions.

| Account | Name | Role |
|---|---|---|
| xxxxxx6600 | BUS SERVICES SAV | Dormant. Transfers only. |
| xxxxxx6715 | EASY BUSINESS CKING | Majority personal spend |
| xxxxxx6723 | PR BUSINESS CKING | Primary operating account |
| xxxxxx6731 | BILL PAY CKING | Mortgages, utilities, card payments |
| xxxxxx6621 | BUS SECURED TERM | Loan. Principal/interest split. |

Known-good validation targets (parser MUST reproduce these exactly):

- Loan 6621 interest paid YTD 2025 = **$1,237.79**
- Loan 6621 balance 12/31/2025 = **$13,425.98**
- July 2025 acct 6715: **25 credits / $18,671.90**, **144 debits / $18,618.56**
- July 2025 acct 6723: **19 credits / $31,378.11**, **81 debits / $38,025.46**
- July 2025 acct 6731: **4 credits / $3,950.00**, **13 debits / $4,784.74**
- Every month's ending balance == next month's beginning balance, all accounts

If the parser does not hit these, it is not done.

---

## FORMAT VARIANTS

### Variant A — "legacy" (Jan, Feb 2025)
Amounts on the DATE line. Description continues on lines BELOW.

```
01/01/2025 Electronic Transfer $45,000.00 $45,030.09
TFR FROM SHARES #######66-72
01/10/2025 Overdraft Transfer $512.00 $14,686.08
BANK OF AMERICA * RIVER ROAD JOHNS ISLAND SCUS
TFR TO SHARES #######66-72
```

> **Correction (2026-08-16):** this spec originally claimed account section
> headers are NOT repeated on continuation pages in variant A, requiring
> header state to persist across page boundaries. Checked directly against
> the real fixtures (both variant A and B): headers repeat with
> "(continued)" on every page in both variants. That part was wrong.
>
> The real A/B difference is where the account nickname sits. Variant B
> splits it across two lines — a verbose label + masked account number, then
> the nickname on its own line below ("Easy Business Checking - XXXXXX6715"
> / "EASY BUSINESS CKING"). Variant A puts the nickname and masked account
> on the same line ("BUS SERVICES SAV - XXXXXX6-00"), with no separate
> verbose-label line. `lib/parsers/accounts.js` matches the nickname as a
> line prefix so it covers both shapes, and carries the current account
> forward across every non-header line regardless — so it doesn't actually
> depend on whether a given page repeats the header or not.

### Variant B — "current" (Mar–Dec 2025)
Description wraps ABOVE. Amounts on the LAST line of the block.

```
07/01/2025 Point Of Sale Withdrawal PLANET VAPE & T 2770
MAYBANK HIGHWAJOHNS ISLAND SCUS $5.45 $6,728.13
```

> **Correction (2026-08-16):** an earlier version of this spec listed a third
> "Variant C — native PDF" for July 2025, requiring a different text-extraction
> path (`pdftotext -layout` / `pdfplumber`). That was investigated against all
> 12 real 2025 fixtures, including July — every one of them classifies cleanly
> as A or B using the standard extractor, with a wide separating margin
> (A: 0.94+ fraction of date lines carrying two inline amounts, B: 0.19–0.43).
> No native-PDF variant exists in the real data. It was a spec error, not an
> SC Federal layout, and has been removed.

---

## CORE RULE — BALANCE-DELTA VALIDATION

This is the most important requirement in this document.

The debit and credit columns collapse into ambiguous whitespace during text
extraction. **Do not infer sign from column position.** Infer it from the running
balance:

```js
const delta = round(currentBalance - priorBalance, 2);
// delta < 0 → debit, delta > 0 → credit
if (Math.abs(Math.abs(delta) - statedAmount) > 0.02) {
  row.flag = 'UNRECONCILED';   // never silently accept
}
```

Every row carries a `flag`. Unreconciled rows go to the review queue. They do NOT
enter the P&L.

Emit a per-account, per-statement reconciliation report:
`beginning + credits - debits === ending`. If that identity fails, the import
fails loudly with the specific account and month named.

> **Correction (2026-08-16):** the balance-delta rule above applies to the 4
> deposit accounts, not the loan. The loan (6621) prints no per-row running
> balance at all — there's nothing to take a delta against. Each payment is
> three lines: `<effective date> <posting date> Regular Payment $<amount>`,
> then `Principal $<x>`, then `Interest $<y>`, and it reconciles on
> `principal + interest == payment` instead. Variant A (legacy) prints these
> with a trailing colon (`Principal: $673.94`, `Interest: $112.02`); variant
> B (current) doesn't (`Principal $671.00`). Both are handled in
> `lib/parsers/rows.js`. The loan's own beginning/ending balance still comes
> from its "Previous Balance" / "New Balance" lines, same as before — only
> the per-transaction reconciliation differs. The bank also prints
> "Interest Paid YTD" directly in each month's summary, which is a useful
> cross-check: December 2025 reads $1,237.79, exactly matching this spec's
> validation target below.

---

## ACCOUNT DEFAULT MATRIX

Each account gets a different default because each behaves differently. This is
new behavior — the current importer treats all accounts identically.

| Account | Default | Notes |
|---|---|---|
| 6600 | EXCLUDE | Dormant, transfers only |
| 6715 | PERSONAL | Business only via vendor whitelist |
| 6723 | BUSINESS | Flag personal for review |
| 6731 | REVIEW | Mostly draws — mortgages, utilities, card pmts |
| 6621 | LOAN | Split principal / interest |

### 6715 business whitelist (seed list — extend from data)
```
BUCK LUMBER, BUILDERSFIRSTSOURCE, LOWE'S, HOME DEPOT, TRACTOR SUPPLY,
SHERWIN-WILLIAMS, HARBOR FREIGHT, ALL SEASONS HARDWARE, SITEONE,
GUSTO, ADP, INTUIT, QUICKBOOKS, DOCUSIGN, PROPOSIFY, JOIST, CANVA,
ADOBE, OPENPHONE, BILLER GENIE, MERCHANT BANKCD, SURFERSEO, BLUEHOST,
GODADDY, MICROSOFT, GOOGLE ADS, TRIDENT WASTE, STARLINK, MINT MOBILE,
A & R SHEET METAL, ISLAND SEPTIC, COASTAL MARINAS
```

### Known-personal patterns (force PERSONAL regardless of account)
```
NETFLIX, DISNEY PLUS, PEACOCK, PARAMOUNT+, SLING, TINDER, BUMBLE,
ONLYFANS, CCBILL, SEEKING, WINGMAN, PURE ANONYMOU, ZEDGE,
STONO LIQUORS, FOOD LION, PUBLIX, HARRIS TEETER, WHOLEFDS,
SUNSHINE SPIRITS, LOWCOUNTRY WINE, PLANET VAPE, ROOMS TO GO,
SYNCHRONY, ROCKET MORTGAGE, LOANDEPOT, IRS - USATAXPYMT
```

---

## TRANSFER ELIMINATION

~40% of transaction volume is internal movement between the four accounts. If
these enter the P&L, revenue and expenses are both overstated by six figures.

Patterns to net to zero:
```
TFR TO CHECKG x####
TFR FRM CHECKG x####
TFR TO SAVGS x####
TFR FRM SAVGS x####
TFR TO SHARES #######66-##
TFR FROM SHARES #######66-##
LOAN PYMT TO LOAN x6621
Overdraft Transfer
Electronic Transfer   (when paired with a SHARES/CHECKG/SAVGS description line)
```

> **Correction (2026-08-16):** three things above differ from what this spec
> originally said, all confirmed against `lib/parsers/transfers.js` running
> on the real 12 fixtures:
>
> - **SAVGS wording.** Variant B (current) doesn't only say "CHECKG" — a
>   transfer to/from the savings account (6600) is worded `TFR TO/FRM SAVGS
>   x6600`, since 6600 isn't a checking account. Missing this pattern left
>   every 6600<->6723 transfer in the current-format months unmatched. The
>   wording is chosen by what the COUNTERPARTY account is, not the account
>   whose statement you're reading: 6600's own ledger calls its transfers to
>   6715/6723/6731 "CHECKG" (they're checking accounts), while 6715/6723/6731
>   call transfers to 6600 "SAVGS".
> - **Legacy SHARES suffix mapping.** Variant A (legacy) never says "CHECKG"
>   or "SAVGS" at all — every inter-account transfer, including
>   checking-to-checking, is worded `TFR TO/FROM SHARES #######<suffix>`,
>   where `<suffix>` is a 2-digit-hyphen-2-digit legacy code, not the 4-digit
>   account number. It isn't derived from any documented mask format — it
>   was reverse-engineered by matching real date+amount pairs across
>   accounts (e.g. 6600's outbound "$5,000.00 TFR TO SHARES #######66-72" on
>   01/07/2025 lines up exactly with 6723's inbound "$5,000.00 TFR FROM
>   SHARES #######66-00" the same day):
>   `66-00→6600, 66-71→6715, 66-72→6723, 66-73→6731, 66-21→6621`.
> - **No "LOAN PYMT FRM CHECKG".** The loan's own ledger never prints that
>   text (removed from the pattern list above). It just prints "Regular
>   Payment" (see the CORE RULE correction above) — every loan payment row
>   is the inbound side of a `LOAN PYMT TO LOAN` transfer by construction,
>   matched on amount + date alone since the loan side carries no
>   counterparty account text to check against.
>
> With these three corrected, transfer volume eliminated (counting both
> legs of each matched pair) comes to 40.5% of total transaction volume —
> matching this spec's own ~40% estimate almost exactly.

Match each outbound to its inbound counterpart by amount + date (±2 days) +
complementary account. Tag matched pairs `INTERNAL_TRANSFER` and exclude from
P&L. **Report unmatched transfers** — an unmatched transfer means a missing
statement or a parse failure.

Add `INTERNAL_TRANSFER` as a first-class category. Do not reuse
`PERSONAL / Non-Business Transfer` — that conflates two very different things.

---

## SHAREHOLDER DISTRIBUTION TALLY

New requirement. Entity is an S-Corp; personal spend paid from business accounts
is a distribution that reduces shareholder basis. Distributions exceeding basis
are taxable capital gain.

Accumulate a running `SHAREHOLDER_DISTRIBUTION` total from every transaction
classified PERSONAL that was paid from a business account. Surface it as a
headline figure on the dashboard alongside the three-tier P&L — it is as
important as any expense number.

---

## BUILD SEQUENCE

Work one step at a time. Confirm each before moving on.

1. **Format detector.** Given raw statement text, return `'A' | 'B'`.
   Test against all 12 fixtures. Must be 12/12.
2. **Extraction layer.** Route to the correct text extractor per variant.
   (Collapsed to a single passthrough once variant C was ruled out — both
   real variants extract the same way.)
3. **Account section state machine.** Track current account across page
   breaks. Headers repeat on every page in both variants, but the state
   machine doesn't depend on that — it switches on a recognized account
   nickname and otherwise carries the current account forward.
4. **Row parser + balance-delta validation.** Target: >99% reconciled.
5. **Reconciliation report.** Per account, per month, assert the balance identity.
   Compare against the known-good targets above.
6. **Transfer matcher.**
7. **Category engine** with the account default matrix.
8. **Distribution tally.**
9. **Wire into the existing import route.** Keep the CSV path working.

---

## CONSTRAINTS

- Verify the current Anthropic model ID before any AI categorization call.
  Retired IDs fail silently.
- Supabase tables are `nn_` prefixed on the shared instance.
- No secrets in the repo. Anthropic keys are account-wide.
- Pre-commit hooks are installed. Do not commit files from other projects.
- Provide a git commit message after each step: bold subject <=50 chars,
  then brief body bullets.

---

## DEFINITION OF DONE

Ryley uploads 12 SC Federal PDFs. The importer:

1. Detects both formats without configuration
2. Parses ~2,830 transactions with >99% reconciled
3. Reproduces every known-good validation target exactly
4. Nets internal transfers to zero and reports unmatched ones
5. Applies per-account category defaults
6. Reports a shareholder distribution total
7. Sends only genuinely ambiguous rows to the review queue

Anything that cannot be reconciled is flagged, never guessed.
