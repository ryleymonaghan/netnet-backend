const router = require('express').Router();
const supabase = require('../lib/supabase');

// Middleware: extract user from token
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

// GET /api/entities
router.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('nn_entities')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/entities
router.post('/', authMiddleware, async (req, res) => {
  const { name, type, tax_id, partners, fiscal_year } = req.body;
  const { data, error } = await supabase
    .from('nn_entities')
    .insert({ user_id: req.user.id, name, type, tax_id, partners, fiscal_year: fiscal_year || 'calendar' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/entities/:id
router.put('/:id', authMiddleware, async (req, res) => {
  const { name, type, tax_id, partners, fiscal_year } = req.body;
  const { data, error } = await supabase
    .from('nn_entities')
    .update({ name, type, tax_id, partners, fiscal_year })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/entities/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('nn_entities')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
