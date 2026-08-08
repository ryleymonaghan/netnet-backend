const router = require('express').Router();
const supabase = require('../lib/supabase');
const anthropic = require('../lib/anthropic');

const TAXONOMY = `REVENUE: Service Revenue, Rental Income, Product Sales, Reimbursements
COGS: Materials & Supplies, Subcontractor Labor, Equipment Rental, Warranty Claims, Job-Site Costs
PAYROLL: Owner Salary/Draw, Employee Wages, Payroll Taxes, Benefits
CONTROLLABLE EXPENSES: Marketing & Advertising, Software & Subscriptions, Professional Services, Travel & Transportation, Meals & Entertainment (50%), Office Supplies, Phone & Communications, Uniforms & Safety Gear
FIXED EXPENSES: Rent / Mortgage, Insurance (GL Workers Comp E&O), Loan Payments, Equipment Payments, Utilities
CAPITAL & ASSETS: Equipment Purchase (Section 179 eligible), Vehicle Purchase, Real Estate, Improvements
PERSONAL: Personal Purchase, Owner Personal Draw, Non-Business Transfer

Guidance on ambiguous construction categories:
- "Warranty Claims" is COGS spent fixing completed work at no charge to the
  customer: callbacks, punch-list repairs after closeout, remediation, rework.
  Look for descriptions naming a finished job plus repair/callback/warranty
  language. It is NOT new work, and NOT a job-site cost on an active build.
- "Job-Site Costs" is spend on an ACTIVE job that is not materials, sub labor,
  or rental: dumpsters, portable toilets, temp power, site fencing, permits.`;

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

// POST /api/categorize/batch — categorize many transactions at once
//
// The previous version made one Claude call per transaction, sequentially, inside
// a single HTTP request. At ~1.5s each, 293 transactions took over seven minutes
// and the platform killed the request long before it finished — and a year of
// statements would have been thousands of calls.
//
// This version sends CHUNK transactions per call and runs several calls in
// parallel, cutting a 293-transaction run from ~293 calls to ~12. It also caps
// how much it will attempt per request and reports what's left, so the client
// can loop and show progress instead of hanging on one enormous request.
const CHUNK = 25;        // transactions per Claude call
const CONCURRENCY = 4;   // chunks in flight
const MAX_PER_REQUEST = 200;

router.post('/batch', authMiddleware, async (req, res) => {
  try {
    const { transaction_ids, entity_id, entity_name, entity_type } = req.body || {};

    // Accept explicit IDs, or select the uncategorized rows ourselves. The old
    // contract required IDs and returned an unhelpful error without them.
    let query = supabase
      .from('nn_transactions')
      .select('id, date, description, amount, entity_id')
      .eq('user_id', req.user.id);

    if (transaction_ids?.length) {
      query = query.in('id', transaction_ids);
    } else {
      query = query.is('category', null);
      if (entity_id) query = query.eq('entity_id', entity_id);
    }

    const { data: all, error } = await query
      .order('date', { ascending: false })
      .limit(MAX_PER_REQUEST + 1);
    if (error) return res.status(500).json({ error: error.message });

    if (!all?.length) {
      return res.json({ categorized: 0, failed: 0, needs_review: 0, remaining: 0,
                        message: 'Nothing to categorize.' });
    }

    const batch = all.slice(0, MAX_PER_REQUEST);
    const remaining = Math.max(0, all.length - batch.length);

    // Entity context helps Claude tell business spend from personal.
    let entityLabel = entity_name, entityKind = entity_type;
    if (!entityLabel) {
      const { data: ents } = await supabase
        .from('nn_entities').select('id, name, type').eq('user_id', req.user.id);
      const map = Object.fromEntries((ents || []).map(e => [e.id, e]));
      const first = map[batch[0].entity_id];
      entityLabel = first?.name || 'Unknown';
      entityKind  = first?.type || 'LLC';
    }

    const chunks = [];
    for (let i = 0; i < batch.length; i += CHUNK) chunks.push(batch.slice(i, i + CHUNK));

    const categorizeChunk = async (rows) => {
      const list = rows.map((t, i) =>
        `${i + 1}. ${t.date} | ${t.description} | $${t.amount}`).join('\n');

      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `You are a tax-savvy accountant categorizing business transactions for a residential construction company.

Entity: ${entityLabel} (${entityKind})

Transactions:
${list}

Assign each from this exact taxonomy:
${TAXONOMY}

Return ONLY a JSON array with one object per transaction, in the same order, no prose and no markdown fences:
[{"n":1,"category":"","subcategory":"","tax_treatment":"deductible|cogs|payroll|personal|capital","write_off":true,"write_off_pct":100,"confidence":0.95,"notes":"Short plain-English reason"}]`,
        }],
      });

      const raw = (message.content || [])
        .filter(b => b.type === 'text').map(b => b.text).join('').trim();
      const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

      let parsed;
      try { parsed = JSON.parse(cleaned); }
      catch {
        // Salvage the array if the model wrapped it in any stray prose.
        const m = cleaned.match(/\[[\s\S]*\]/);
        if (!m) throw new Error('Could not parse the model response');
        parsed = JSON.parse(m[0]);
      }
      if (!Array.isArray(parsed)) throw new Error('Model did not return an array');

      const updates = [];
      for (const item of parsed) {
        const idx = Number(item.n) - 1;
        const tx = rows[idx];
        if (!tx || !item.category) continue;
        updates.push({ tx, item });
      }

      await Promise.all(updates.map(({ tx, item }) =>
        supabase.from('nn_transactions').update({
          category: item.category,
          subcategory: item.subcategory || null,
          tax_treatment: item.tax_treatment || null,
          write_off: item.write_off ?? null,
          write_off_pct: item.write_off_pct ?? null,
          confidence: item.confidence ?? null,
          ai_notes: item.notes || null,
        }).eq('id', tx.id).eq('user_id', req.user.id)
      ));

      return updates.map(u => ({ id: u.tx.id, confidence: u.item.confidence ?? null }));
    };

    let done = [];
    let failed = 0;
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const slice = chunks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(slice.map(categorizeChunk));
      settled.forEach((r, j) => {
        if (r.status === 'fulfilled') done = done.concat(r.value);
        else {
          failed += slice[j].length;
          console.error('[NN] chunk failed:', r.reason?.message);
        }
      });
    }

    res.json({
      categorized: done.length,
      failed,
      needs_review: done.filter(d => d.confidence !== null && d.confidence < 0.75).length,
      remaining,
      chunks: chunks.length,
    });
  } catch (err) {
    console.error('[NN] Batch categorize error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
