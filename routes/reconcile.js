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

// GET /api/reconcile — list reconciliation records
router.get('/', authMiddleware, async (req, res) => {
  const { account_id } = req.query;
  let query = supabase
    .from('nn_reconciliation')
    .select('*')
    .order('created_at', { ascending: false });

  if (account_id) query = query.eq('account_id', account_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/reconcile — create a reconciliation
router.post('/', authMiddleware, async (req, res) => {
  const { account_id, period, period_type, statement_balance } = req.body;

  // Calculate balance from transactions for this period
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = new Date(Number(year), Number(month), 0).toISOString().split('T')[0];

  const { data: txs, error: txErr } = await supabase
    .from('nn_transactions')
    .select('amount')
    .eq('account_id', account_id)
    .gte('date', startDate)
    .lte('date', endDate);

  if (txErr) return res.status(500).json({ error: txErr.message });

  const calculated = txs.reduce((sum, t) => sum + Number(t.amount), 0);
  const difference = Number(statement_balance) - calculated;

  const { data, error } = await supabase
    .from('nn_reconciliation')
    .insert({
      account_id,
      period,
      period_type: period_type || 'monthly',
      statement_balance: Number(statement_balance),
      calculated_balance: calculated,
      difference,
      status: Math.abs(difference) < 0.01 ? 'balanced' : 'discrepancy',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

module.exports = router;
