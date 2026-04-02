const router = require('express').Router();
const supabase = require('../lib/supabase');
const anthropic = require('../lib/anthropic');

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

// GET /api/opportunities
router.get('/', authMiddleware, async (req, res) => {
  const { entity_id } = req.query;
  let query = supabase
    .from('nn_opportunities')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (entity_id) query = query.eq('entity_id', entity_id);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/opportunities/scan — AI scan for write-offs
router.post('/scan', authMiddleware, async (req, res) => {
  try {
    const { entity_id } = req.body;

    // Get all categorized transactions for this entity
    const { data: txs, error } = await supabase
      .from('nn_transactions')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('entity_id', entity_id)
      .not('category', 'is', null);

    if (error) return res.status(500).json({ error: error.message });
    if (!txs.length) return res.json({ opportunities: [] });

    const txSummary = txs.map(t => `${t.date} | ${t.description} | $${t.amount} | ${t.category} > ${t.subcategory}`).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are a tax strategist reviewing categorized business transactions. Scan for:
- Section 179 deductions (equipment/vehicles > $500)
- Home office deductions
- Vehicle mileage deductions
- Meals at 50% vs incorrectly at 100%
- Commingled personal/business expenses
- Missing receipts for cash > $75
- Depreciation opportunities
- Partnership basis tracking issues

Transactions:
${txSummary}

Return a JSON array of opportunities:
[{
  "type": "section_179|home_office|vehicle|meals|depreciation|missed_deduction",
  "title": "Short title",
  "description": "Plain English explanation",
  "amount": estimated_savings_number
}]

Return [] if no opportunities found.`
      }],
    });

    const opportunities = JSON.parse(message.content[0].text);

    // Store opportunities
    if (opportunities.length) {
      const rows = opportunities.map(o => ({
        user_id: req.user.id,
        entity_id,
        type: o.type,
        title: o.title,
        description: o.description,
        amount: o.amount,
        status: 'open',
      }));
      await supabase.from('nn_opportunities').insert(rows);
    }

    res.json({ opportunities });
  } catch (err) {
    console.error('[NN] Opportunity scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/opportunities/:id — update status
router.put('/:id', authMiddleware, async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase
    .from('nn_opportunities')
    .update({ status })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
