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
  const { entity_id, account_id, limit = 100, offset = 0 } = req.query;
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
