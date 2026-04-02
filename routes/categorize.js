const router = require('express').Router();
const supabase = require('../lib/supabase');
const anthropic = require('../lib/anthropic');

const TAXONOMY = `REVENUE: Service Revenue, Rental Income, Product Sales, Reimbursements
COGS: Materials & Supplies, Subcontractor Labor, Equipment Rental, Job-Site Costs
PAYROLL: Owner Salary/Draw, Employee Wages, Payroll Taxes, Benefits
CONTROLLABLE EXPENSES: Marketing & Advertising, Software & Subscriptions, Professional Services, Travel & Transportation, Meals & Entertainment (50%), Office Supplies, Phone & Communications, Uniforms & Safety Gear
FIXED EXPENSES: Rent / Mortgage, Insurance (GL Workers Comp E&O), Loan Payments, Equipment Payments, Utilities
CAPITAL & ASSETS: Equipment Purchase (Section 179 eligible), Vehicle Purchase, Real Estate, Improvements
PERSONAL: Personal Purchase, Owner Personal Draw, Non-Business Transfer`;

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

// POST /api/categorize — categorize a single transaction
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { transaction_id, entity_name, entity_type } = req.body;

    // Fetch the transaction
    const { data: tx, error: txErr } = await supabase
      .from('nn_transactions')
      .select('*')
      .eq('id', transaction_id)
      .eq('user_id', req.user.id)
      .single();
    if (txErr || !tx) return res.status(404).json({ error: 'Transaction not found' });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `You are a tax-savvy accountant categorizing business transactions.

Entity: ${entity_name || 'Unknown'} (${entity_type || 'LLC'})
Transaction: ${tx.date} | ${tx.description} | $${tx.amount}

Assign from this exact taxonomy:
${TAXONOMY}

Return JSON only:
{
  "category": "",
  "subcategory": "",
  "tax_treatment": "deductible|cogs|payroll|personal|capital",
  "write_off": true|false,
  "write_off_pct": 100,
  "confidence": 0.95,
  "notes": "Plain English explanation"
}`
      }],
    });

    const text = message.content[0].text;
    const json = JSON.parse(text);

    // Update the transaction with AI results
    const { data: updated, error: updateErr } = await supabase
      .from('nn_transactions')
      .update({
        category: json.category,
        subcategory: json.subcategory,
        tax_treatment: json.tax_treatment,
        write_off: json.write_off,
        write_off_pct: json.write_off_pct,
        confidence: json.confidence,
        ai_notes: json.notes,
      })
      .eq('id', transaction_id)
      .select()
      .single();

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json(updated);
  } catch (err) {
    console.error('[NN] Categorize error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/categorize/batch — categorize multiple transactions
router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const { transaction_ids, entity_name, entity_type } = req.body;
    if (!transaction_ids?.length) return res.status(400).json({ error: 'No transaction IDs provided' });

    const { data: txs, error } = await supabase
      .from('nn_transactions')
      .select('*')
      .in('id', transaction_ids)
      .eq('user_id', req.user.id);
    if (error) return res.status(500).json({ error: error.message });

    const results = [];
    for (const tx of txs) {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 256,
          messages: [{
            role: 'user',
            content: `You are a tax-savvy accountant categorizing business transactions.

Entity: ${entity_name || 'Unknown'} (${entity_type || 'LLC'})
Transaction: ${tx.date} | ${tx.description} | $${tx.amount}

Assign from this exact taxonomy:
${TAXONOMY}

Return JSON only:
{
  "category": "",
  "subcategory": "",
  "tax_treatment": "deductible|cogs|payroll|personal|capital",
  "write_off": true|false,
  "write_off_pct": 100,
  "confidence": 0.95,
  "notes": "Plain English explanation"
}`
          }],
        });

        const json = JSON.parse(message.content[0].text);
        await supabase
          .from('nn_transactions')
          .update({
            category: json.category,
            subcategory: json.subcategory,
            tax_treatment: json.tax_treatment,
            write_off: json.write_off,
            write_off_pct: json.write_off_pct,
            confidence: json.confidence,
            ai_notes: json.notes,
          })
          .eq('id', tx.id);
        results.push({ id: tx.id, ...json });
      } catch (err) {
        results.push({ id: tx.id, error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
