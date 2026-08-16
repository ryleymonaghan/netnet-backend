// SC Federal statements ship in two text layouts (NETNET_PARSER_SPEC.md).
// Variant A puts both amounts on the date line itself; variant B defers them
// to the last line of the transaction block, so most date lines carry zero
// or one inline amount instead of two. Across all 12 confirmed 2025
// fixtures, legacy (A) statements land at a 0.94+ fraction of date lines
// carrying two inline amounts, current (B) statements land at 0.19-0.43 —
// a wide gap. We use that gap as a dead zone: anything that doesn't clearly
// land on one side is unclassifiable and throws rather than being guessed.
//
// A third "native PDF" variant was in the original spec (attributed to one
// month requiring a different text-extraction path) but never showed up in
// the real fixtures — it was a spec error, not an actual SC Federal layout,
// and has been removed.
const RE_DATE_LINE = /^\d{2}\/\d{2}\/\d{4}\b/;
const RE_MONEY = /-?\$[\d,]+\.\d{2}/g;

const A_THRESHOLD = 0.75;
const B_THRESHOLD = 0.55;

function detectFormat(rawText, label = 'input') {
  const lines = String(rawText || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const dateLines = lines.filter(l => RE_DATE_LINE.test(l));

  if (dateLines.length === 0) {
    throw new Error(
      `detectFormat: no date-anchored lines found in "${label}" ` +
      `(${lines.length} non-empty lines total) — cannot classify as A or B.`
    );
  }

  const withTwoAmounts = dateLines.filter(l => (l.match(RE_MONEY) || []).length >= 2);
  const fraction = withTwoAmounts.length / dateLines.length;

  if (fraction >= A_THRESHOLD) return 'A';
  if (fraction <= B_THRESHOLD) return 'B';

  throw new Error(
    `detectFormat: ambiguous layout in "${label}" — ${withTwoAmounts.length}/${dateLines.length} ` +
    `date lines carry two inline amounts (fraction ${fraction.toFixed(3)}), which falls between the ` +
    `A (>= ${A_THRESHOLD}) and B (<= ${B_THRESHOLD}) bands.`
  );
}

module.exports = { detectFormat };
