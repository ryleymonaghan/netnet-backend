const router = require('express').Router();
const multer = require('multer');
const supabase = require('../lib/supabase');
const { parseCSV } = require('../lib/parsers/csv');
const { parsePDF } = require('../lib/parsers/pdf');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// GET /api/transactions
router.get('/', authMiddleware, async (req, res) => {
  // Default was 100, and the client never overrode it — so a 293-transaction
  // import silently loaded a third of the data and every total was wrong.
  const { entity_id, account_id, limit = 5000, offset = 0 } = req.query;
  let query = supabase
    .from('nn_transactions')
    .select('*')
    .eq('user_id', req.user.id)
    .order('date', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (entity_id) query = query.eq('entity_id', entity_id);
  if (account_id) query = query.eq('account_id', account_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/transactions/upload — upload CSV or PDF
router.post('/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { account_id, entity_id } = req.body;
    const filename = req.file.originalname;
    const ext = filename.split('.').pop().toLowerCase();
    let parsed;

    if (ext === 'csv') {
      parsed = parseCSV(req.file.buffer);
    } else if (ext === 'pdf') {
      parsed = await parsePDF(req.file.buffer);
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use CSV or PDF.' });
    }

    if (!parsed.length) return res.status(400).json({ error: 'No transactions found in file' });

    // Insert parsed transactions
    const rows = parsed.map(tx => ({
      user_id: req.user.id,
      account_id: account_id || null,
      entity_id: entity_id || null,
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      type: tx.type,
      source: ext === 'csv' ? 'csv_upload' : 'pdf_upload',
      source_file: filename,
    }));

    const { data, error } = await supabase
      .from('nn_transactions')
      .insert(rows)
      .select();

    if (error) return res.status(500).json({ error: error.message });

    // Log the upload
    await supabase.from('nn_uploads').insert({
      user_id: req.user.id,
      account_id: account_id || null,
      filename,
      status: 'complete',
      tx_count: data.length,
    });

    res.json({ success: true, count: data.length, transactions: data });
  } catch (err) {
    console.error('[NN] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/analyze ─────────────────────────────────────────
// Read-only. Parses the statement, groups by account, reconciles each against
// its own stated ending balance, and suggests a mapping to the user's accounts.
// Nothing is written — the user confirms the mapping, then calls /import.
router.post('/analyze', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.originalname;
    const ext = (filename.split('.').pop() || '').toLowerCase();

    const { data: accounts } = await supabase
      .from('nn_accounts').select('*').eq('user_id', req.user.id);

    let detected;
    if (ext === 'pdf') {
      detected = await parsePDF(req.file.buffer);
    } else if (ext === 'csv') {
      const rows = parseCSV(req.file.buffer);
      detected = [{
        label: 'Statement', mask: null, key: null,
        beginning_balance: null, ending_balance: null, computed_balance: null,
        difference: null, balanced: null,
        count: rows.length, flagged: 0, transactions: rows,
      }];
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Upload a CSV or PDF.' });
    }

    if (!detected.length) {
      return res.status(422).json({
        error: 'No transactions found. This statement layout may not be supported yet.',
      });
    }

    // Suggest a match on the trailing digits of the account number. The bank
    // masks all but the last few, so compare the digits we actually have.
    const suggest = (key) => {
      if (!key) return null;
      const hit = (accounts || []).find(a => {
        const l4 = String(a.last4 || '').replace(/\D/g, '');
        if (!l4) return false;
        return key.endsWith(l4) || l4.endsWith(key);
      });
      return hit ? hit.id : null;
    };

    res.json({
      filename,
      accounts: detected.map(a => ({
        label: a.label,
        mask: a.mask,
        key: a.key,
        count: a.count,
        flagged: a.flagged,
        beginning_balance: a.beginning_balance,
        ending_balance: a.ending_balance,
        computed_balance: a.computed_balance,
        difference: a.difference,
        balanced: a.balanced,
        suggested_account_id: suggest(a.key),
        sample: a.transactions.slice(0, 3).map(t => ({
          date: t.date, description: t.description, amount: t.amount,
        })),
      })),
    });
  } catch (err) {
    console.error('[NN] Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/transactions/import ──────────────────────────────────────────
// Re-parses the same file and writes only the account sections the user mapped.
// Skips rows that already exist (same account, date, amount, description) so a
// re-upload of an overlapping period doesn't double-count.
router.post('/import', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let mapping;
    try {
      mapping = JSON.parse(req.body.mapping || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid mapping' });
    }
    if (!Object.keys(mapping).length) {
      return res.status(400).json({ error: 'Map at least one account before importing.' });
    }

    const filename = req.file.originalname;
    const ext = (filename.split('.').pop() || '').toLowerCase();

    const { data: accounts } = await supabase
      .from('nn_accounts').select('id, entity_id').eq('user_id', req.user.id);
    const entityOf = Object.fromEntries((accounts || []).map(a => [a.id, a.entity_id]));

    let detected;
    if (ext === 'pdf') {
      detected = await parsePDF(req.file.buffer);
    } else {
      detected = [{ key: 'csv', mask: null, transactions: parseCSV(req.file.buffer) }];
    }

    const results = [];
    let imported = 0, skipped = 0;

    for (const section of detected) {
      const mapKey = section.mask || section.key || 'csv';
      const accountId = mapping[mapKey];
      if (!accountId) continue;
      if (!entityOf[accountId]) {
        results.push({ mask: mapKey, error: 'Account not found' });
        continue;
      }

      // Existing rows for this account in the statement's date range.
      const dates = section.transactions.map(t => t.date).sort();
      const { data: existing } = await supabase
        .from('nn_transactions')
        .select('date, amount, description')
        .eq('user_id', req.user.id)
        .eq('account_id', accountId)
        .gte('date', dates[0])
        .lte('date', dates[dates.length - 1]);

      const seen = new Set((existing || []).map(
        e => `${e.date}|${Number(e.amount).toFixed(2)}|${e.description}`
      ));

      const rows = [];
      for (const t of section.transactions) {
        const sig = `${t.date}|${Number(t.amount).toFixed(2)}|${t.description}`;
        if (seen.has(sig)) { skipped++; continue; }
        seen.add(sig);
        rows.push({
          user_id: req.user.id,
          account_id: accountId,
          entity_id: entityOf[accountId],
          date: t.date,
          description: t.description,
          amount: t.amount,
          type: t.type,
          source: ext === 'csv' ? 'csv_upload' : 'pdf_upload',
          source_file: filename,
          ai_notes: t.note || null,
        });
      }

      let inserted = 0;
      // Chunked — a full year of activity can run to thousands of rows.
      for (let i = 0; i < rows.length; i += 500) {
        const { data, error } = await supabase
          .from('nn_transactions').insert(rows.slice(i, i + 500)).select('id');
        if (error) { results.push({ mask: mapKey, error: error.message }); break; }
        inserted += data.length;
      }
      imported += inserted;

      await supabase.from('nn_uploads').insert({
        user_id: req.user.id,
        account_id: accountId,
        filename,
        period_start: dates[0] || null,
        period_end: dates[dates.length - 1] || null,
        status: 'complete',
        tx_count: inserted,
      });

      results.push({
        mask: mapKey,
        label: section.label || null,
        imported: inserted,
        balanced: section.balanced ?? null,
        difference: section.difference ?? null,
      });
    }

    res.json({ success: true, count: imported, skipped, results });
  } catch (err) {
    console.error('[NN] Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/transactions/:id — update category/corrections
router.put('/:id', authMiddleware, async (req, res) => {
  const { category, subcategory, tax_treatment, write_off, write_off_pct, reconciled } = req.body;
  const { data, error } = await supabase
    .from('nn_transactions')
    .update({ category, subcategory, tax_treatment, write_off, write_off_pct, reconciled })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
