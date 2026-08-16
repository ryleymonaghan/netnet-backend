// Extraction layer (NETNET_PARSER_SPEC.md, Step 2). Originally meant to
// route to a different text extractor per format variant — variant C
// ("native PDF", needing pdftotext -layout / pdfplumber) was supposed to
// need a different path than A/B. C didn't survive Step 1 investigation:
// it never showed up in the real fixtures, so both real variants extract
// the same way. This stays a named seam rather than calling pdf.js's
// extractText directly, in case a future variant needs a different path.
const { extractText } = require('./pdf');

async function extractStatementText(buffer) {
  return extractText(buffer);
}

module.exports = { extractStatementText };
