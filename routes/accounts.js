const router = require('express').Router();
const supabase = require('../lib/supabase');

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

// GET /api/accounts
router.get('/', authMiddleware, async (req, res) => {
  const { data, error } = await supabase
    .from('nn_accounts')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/accounts
router.post('/', authMiddleware, async (req, res) => {
  const { entity_id, name, type, last4, institution, balance, currency } = req.body;
  const { data, error } = await supabase
    .from('nn_accounts')
    .insert({ user_id: req.user.id, entity_id, name, type, last4, institution, balance: balance || 0, currency: currency || 'USD' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/accounts/:id
router.put('/:id', authMiddleware, async (req, res) => {
  const { name, type, last4, institution, balance } = req.body;
  const { data, error } = await supabase
    .from('nn_accounts')
    .update({ name, type, last4, institution, balance })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/accounts/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  const { error } = await supabase
    .from('nn_accounts')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
