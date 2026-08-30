const router = require('express').Router();
const supabase = require('../lib/supabase');
const anthropic = require('../lib/anthropic');
const { applyRules } = require('../lib/rules');

// Pinned snapshot IDs expire. claude-sonnet-4-20250514 was retired 2026-06-15
// and every call failed with no visible reason. Use the alias, overridable by
// env so a future migration is a variable change rather than a code change.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

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
  or rental: dumpsters, portable toilets, temp power, site fencing, permits.

NEEDS_REVIEW is a real answer and you must use it. If the description does not
tell you what the money was for, return NEEDS_REVIEW rather than the closest
plausible category. A wrong deduction gets disallowed; wrongly booked income gets
characterized. Neither is recoverable by a confidence score, and a category you
picked at 0.6 is indistinguishable downstream from one you knew. Abstaining is
cheap: it puts one line in front of the owner. Guessing is not.`;

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
      model: MODEL,
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
      .eq('user_id', req.user.id)
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

    // ── Rule pass, before any API call ───────────────────────────────────────
    // Transfers, reversals and classified senders have right answers. Rows the
    // rules ABSTAIN on are written as NEEDS_REVIEW and deliberately never reach
    // the model — sending an unknown Zelle sender to Claude just launders a
    // guess into a confidence score.
    const { data: knownSenders } = await supabase
      .from('nn_known_senders')
      .select('name, classification, note')
      .eq('user_id', req.user.id);

    const ruleCtx = { knownSenders: knownSenders || [] };
    const ruled = [];
    const toModel = [];
    for (const tx of batch) {
      const r = applyRules(tx, ruleCtx);
      if (r) ruled.push({ tx, r }); else toModel.push(tx);
    }

    await Promise.all(ruled.map(({ tx, r }) =>
      supabase.from('nn_transactions').update({
        category: r.category,
        subcategory: r.subcategory,
        tax_treatment: r.tax_treatment,
        write_off: r.write_off,
        write_off_pct: r.write_off_pct,
        confidence: r.confidence,
        ai_notes: r.notes || null,
      }).eq('id', tx.id).eq('user_id', req.user.id)
    ));

    const ruleReview = ruled.filter(x => x.r.needs_review).length;

    // Entity context helps Claude tell business spend from personal.
    let entityLabel = entity_name, entityKind = entity_type;
    if (!entityLabel) {
      const { data: ents } = await supabase
        .from('nn_entities').select('id, name, type').eq('user_id', req.user.id);
      const map = Object.fromEntries((ents || []).map(e => [e.id, e]));
      const first = map[batch[0]?.entity_id];
      entityLabel = first?.name || 'Unknown';
      entityKind  = first?.type || 'LLC';
    }

    const chunks = [];
    for (let i = 0; i < toModel.length; i += CHUNK) chunks.push(toModel.slice(i, i + CHUNK));

    const categorizeChunk = async (rows) => {
      const list = rows.map((t, i) =>
        `${i + 1}. ${t.date} | ${t.description} | $${t.amount}`).join('\n');

      const message = await anthropic.messages.create({
        model: MODEL,
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
[{"n":1,"category":"","subcategory":"","tax_treatment":"deductible|cogs|payroll|personal|capital","write_off":true,"write_off_pct":100,"confidence":0.95,"notes":"Short plain-English reason"}]

Return one object for EVERY numbered transaction. If you cannot tell what a row
was for, that row's category is "NEEDS_REVIEW" with confidence null — do not omit
it and do not substitute your best guess.`,
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
      const seen = new Set();
      for (const item of parsed) {
        const idx = Number(item.n) - 1;
        const tx = rows[idx];
        if (!tx || !item.category) continue;
        seen.add(tx.id);
        updates.push({ tx, item });
      }

      // A row the model skipped used to be counted as neither categorized nor
      // failed. It stayed category:null, the response reported success, and the
      // owner's totals were quietly short by however many rows were dropped.
      // Silence is the worst possible outcome here — surface them as review.
      const dropped = rows.filter(t => !seen.has(t.id));
      for (const tx of dropped) {
        updates.push({ tx, item: {
          category: 'NEEDS_REVIEW', subcategory: null, tax_treatment: null,
          write_off: false, write_off_pct: null, confidence: null,
          notes: 'The categorizer returned no answer for this row. Not skipped, not assumed — yours to classify.',
        }});
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

      return updates.map(u => ({
        id: u.tx.id,
        category: u.item.category,
        confidence: u.item.confidence ?? null,
      }));
    };

    let done = [];
    let failed = 0;
    const errors = [];
    for (let i = 0; i < chunks.length; i += CONCURRENCY) {
      const slice = chunks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(slice.map(categorizeChunk));
      settled.forEach((r, j) => {
        if (r.status === 'fulfilled') done = done.concat(r.value);
        else {
          failed += slice[j].length;
          const msg = r.reason?.message || String(r.reason);
          if (!errors.includes(msg)) errors.push(msg);
          console.error('[NN] chunk failed:', msg);
        }
      });
    }

    // needs_review is every row a human must look at, from any source: rules
    // that abstained, the model's own NEEDS_REVIEW, rows it dropped, and
    // anything it answered below the confidence floor.
    const modelReview = done.filter(d =>
      d.category === 'NEEDS_REVIEW' || (d.confidence !== null && d.confidence < 0.75)).length;

    res.json({
      categorized: ruled.length + done.length,
      by_rules: ruled.length,
      by_model: done.length,
      failed,
      needs_review: ruleReview + modelReview,
      remaining,
      chunks: chunks.length,
      model: MODEL,
      // Without this a total failure just reported "0 categorized" with no clue why.
      errors: errors.slice(0, 3),
    });
  } catch (err) {
    console.error('[NN] Batch categorize error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
