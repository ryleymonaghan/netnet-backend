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
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (account_id) query = query.eq('account_id', account_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/reconcile — create a reconciliation
router.post('/', authMiddleware, async (req, res) => {
  const { account_id, period, period_type, statement_balance } = req.body;

  if (!account_id) return res.status(400).json({ error: 'account_id is required' });

  // The service-role client bypasses RLS, so ownership is enforced here or not
  // at all. Without this check any authenticated caller could pass a stranger's
  // account_id and read that account's period total back out of `calculated`.
  const { data: acct, error: acctErr } = await supabase
    .from('nn_accounts')
    .select('id')
    .eq('id', account_id)
    .eq('user_id', req.user.id)
    .maybeSingle();

  if (acctErr) return res.status(500).json({ error: acctErr.message });
  if (!acct) return res.status(404).json({ error: 'Account not found' });

  // Calculate balance from transactions for this period
  const [year, month] = period.split('-');
  const startDate = `${year}-${month}-01`;
  const endDate = new Date(Number(year), Number(month), 1, -1).toISOString().split('T')[0];

  const { data: txs, error: txErr } = await supabase
    .from('nn_transactions')
    .select('amount')
    .eq('user_id', req.user.id)
    .eq('account_id', account_id)
    .gte('date', startDate)
    .lte('date', endDate);

  if (txErr) return res.status(500).json({ error: txErr.message });

  const calculated = txs.reduce((sum, t) => sum + Number(t.amount), 0);
  const difference = Number(statement_balance) - calculated;

  const { data, error } = await supabase
    .from('nn_reconciliation')
    .insert({
      user_id: req.user.id,
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
