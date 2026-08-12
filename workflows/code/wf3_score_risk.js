/**
 * WF3 - AI Risk Analysis
 * Node: "Score Risk"  (Code node, Mode = Run Once for All Items)
 *
 * Repo copy: workflows/code/wf3_score_risk.js
 *
 * Turns each extracted clause into a risk_score (0..1) and a
 * risk_level, and decides whether it needs a human.
 *
 * WHY THIS IS RULES AND NOT ANOTHER LLM CALL
 * Ask a model to score risk and the same clause scores 0.6 today and
 * 0.75 next week, with no explanation for either. A rules table gives a
 * number that can be defended - "an absent liability cap scores 0.90
 * because the policy config says so" - and makes WF6's aggregates
 * comparable across runs. It is also free and instant.
 *
 * The scores below are a starting policy, not received wisdom. They are
 * in one block at the top precisely so they can be argued with and
 * changed without touching the logic.
 */

// ===============================================================
// POLICY CONFIG
// ===============================================================

/**
 * BASE_RISK - inherent risk of each clause type when present and normal.
 * Governing Law is low: unfavourable law is inconvenient, not dangerous.
 * Cap On Liability is higher because the amount matters enormously.
 */
const BASE_RISK = {
  'Governing Law': 0.20,
  'Termination For Convenience': 0.50,
  'Cap On Liability': 0.55,
  'Renewal Term': 0.40,
  'Anti-Assignment': 0.35,
};

/**
 * ABSENT_RISK - risk when the clause type is MISSING from the contract.
 *
 * Absence is not the same as low risk, and for some types it is worse
 * than presence. No liability cap means unlimited exposure. No
 * anti-assignment clause means the counterparty can hand the contract
 * to a competitor. A missing governing law clause, by contrast, is a
 * gap the law itself will fill.
 *
 * This asymmetry is the whole reason is_absent rows exist.
 */
const ABSENT_RISK = {
  'Governing Law': 0.30,
  'Termination For Convenience': 0.25,
  'Cap On Liability': 0.90,
  'Renewal Term': 0.45,
  'Anti-Assignment': 0.60,
};

/**
 * MODIFIERS - textual signals that adjust the base score.
 * Applied only to clauses that are present. Cumulative, then clamped.
 */
const MODIFIERS = [
  // Automatic renewal with a short objection window is a classic trap.
  { types: ['Renewal Term'], pattern: /automatic(ally)?\s+renew/i, delta: +0.20,
    note: 'auto-renews' },
  { types: ['Renewal Term'], pattern: /\b(thirty|30)\s*\(?30?\)?\s*days?\b/i, delta: +0.10,
    note: 'short notice window' },

  // Unlimited or carved-out liability.
  { types: ['Cap On Liability'], pattern: /unlimited|no\s+limit|shall\s+not\s+be\s+limited/i,
    delta: +0.30, note: 'liability not truly capped' },
  { types: ['Cap On Liability'], pattern: /fees\s+paid|amounts?\s+paid/i, delta: -0.15,
    note: 'capped at fees paid' },

  // One-sided termination.
  { types: ['Termination For Convenience'], pattern: /sole\s+discretion/i, delta: +0.15,
    note: 'sole discretion' },
  { types: ['Termination For Convenience'], pattern: /immediately|without\s+notice/i,
    delta: +0.20, note: 'no notice period' },

  // Assignment restrictions that bite on ordinary corporate events.
  { types: ['Anti-Assignment'], pattern: /change\s+of\s+control/i, delta: +0.20,
    note: 'change of control triggers' },
  { types: ['Anti-Assignment'], pattern: /not\s+be\s+unreasonably\s+withheld/i, delta: -0.15,
    note: 'consent not unreasonably withheld' },
];

/** Score bands. risk_level must match the DB CHECK in migration 003. */
const RISK_BANDS = [
  { max: 0.35, level: 'low' },
  { max: 0.60, level: 'medium' },
  { max: 0.85, level: 'high' },
  { max: 1.01, level: 'critical' },
];

/**
 * CONFIDENCE_THRESHOLD - below this, a human reviews it (WF4).
 *
 * 0.70 is a placeholder. The project plan says tau is decided
 * empirically in Phase 2 from the DEV set only. Do not tune this
 * against holdout data - that would make the final number self-graded.
 */
const CONFIDENCE_THRESHOLD = 0.70;

// ===============================================================
// LOGIC
// ===============================================================

const clamp = (n) => Math.min(1, Math.max(0, n));

function bandFor(score) {
  for (const b of RISK_BANDS) {
    if (score < b.max) return b.level;
  }
  return 'critical';
}

return items.map((item) => {
  const c = item.json;
  const type = c.clause_type;

  let score;
  const notes = [];

  if (c.is_absent) {
    score = ABSENT_RISK[type] ?? 0.50;
    notes.push('clause absent');
  } else {
    score = BASE_RISK[type] ?? 0.50;

    const text = c.clause_text || '';
    for (const mod of MODIFIERS) {
      if (!mod.types.includes(type)) continue;
      if (mod.pattern.test(text)) {
        score += mod.delta;
        notes.push(mod.note);
      }
    }

    // A shaky extraction is itself a risk: if the model is unsure it
    // read the clause correctly, the clause deserves more attention,
    // not less. Small nudge only - confidence is reported separately
    // and should not be double-counted into the risk figure.
    if (Number(c.confidence) < 0.60) {
      score += 0.05;
      notes.push('low extraction confidence');
    }
  }

  score = clamp(score);

  // Absent clauses have NULL confidence, so they cannot be compared
  // against the threshold. They are routed for review on their own
  // merit: a missing high-risk clause is exactly what a lawyer should
  // be told about.
  const needsReview = c.is_absent
    ? score >= 0.60
    : Number(c.confidence) < CONFIDENCE_THRESHOLD;

  return {
    json: {
      ...c,
      risk_score: Number(score.toFixed(3)),
      risk_level: bandFor(score),
      risk_notes: notes.join('; ') || null,
      needs_review: needsReview,
      review_status: needsReview ? 'pending_review' : 'auto',
      confidence_threshold: CONFIDENCE_THRESHOLD,
    },
  };
});
