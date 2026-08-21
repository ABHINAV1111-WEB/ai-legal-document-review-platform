"""
Phase 4 evaluation: score the extraction pipeline against CUAD gold labels.

What this measures
------------------
For every (contract, clause_type) pair in the chosen split, compare what the
pipeline put in `clauses` against what CUAD's lawyers annotated in
`gold_labels`.

Three numbers come out:

  detection recall   - of all pairs, how many did the pipeline find at all?
  span precision     - of all spans the pipeline asserted, how many were right?
  mean token F1      - how close was the best span, on average?

Why text matching and not character offsets
-------------------------------------------
`gold_labels.answer_start` indexes into CUAD's own text extraction of the
contract. `clauses.char_start` indexes into OUR pdf-extracted text. Different
extractors, different whitespace, different offsets. Comparing them would
produce noise. So matching is done SQuAD-style: normalise both strings, then
compute token-level F1.

Why there are no true negatives
-------------------------------
prepare_dataset.py selected contracts CONTAINING all five clause types, so
every one of the 150 gold pairs is present. There are no "clause genuinely
absent" rows to test against. Consequence: this script cannot measure
hallucinated clauses, and does not claim to. Every row where the pipeline
asserted is_absent=true is, by construction, a false negative.

Holdout safety
--------------
Defaults to --split dev. The script prints METRICS ONLY - it never prints
contract text unless --show-misses is passed, and that flag is refused for
the holdout split. Phase 4 runs this with --split holdout and nothing else
changes.

Place at:  <project root>/scripts/evaluate.py
Run from:  <project root>   ->   python scripts/evaluate.py
"""

from __future__ import annotations

import argparse
import os
import re
import string
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is not installed.  Fix: pip install -r requirements.txt")
    sys.exit(1)

try:
    from dotenv import load_dotenv
except ImportError:
    print("ERROR: python-dotenv is not installed.  Fix: pip install -r requirements.txt")
    sys.exit(1)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = PROJECT_ROOT / ".env"
REPORT_PATH = PROJECT_ROOT / "docs" / "evaluation.md"

# A predicted span counts as correct when its token F1 against the best gold
# span reaches this. 0.50 is the conventional partial-credit threshold for
# span extraction: it demands real overlap but tolerates boundary drift, which
# is unavoidable when two different PDF extractors disagree about where a
# paragraph starts.
DEFAULT_THRESHOLD = 0.50


# ===================================================================
# Text normalisation and scoring (SQuAD convention)
# ===================================================================

_PUNCT_TABLE = str.maketrans("", "", string.punctuation)
_ARTICLES = re.compile(r"\b(a|an|the)\b", flags=re.UNICODE)


def normalise(text: str) -> str:
    """Lowercase, strip punctuation and articles, collapse whitespace."""
    if not text:
        return ""
    text = text.lower()
    text = text.translate(_PUNCT_TABLE)
    text = _ARTICLES.sub(" ", text)
    return " ".join(text.split())


def tokens(text: str) -> list[str]:
    return normalise(text).split()


def token_f1(pred: str, gold: str) -> float:
    """
    Token-level F1 between two strings.

    Uses a multiset intersection, so a word repeated three times in the
    prediction but once in gold contributes one match, not three.
    """
    p_tokens = tokens(pred)
    g_tokens = tokens(gold)

    if not p_tokens or not g_tokens:
        # Both empty is a perfect match; one empty is a total miss.
        return float(p_tokens == g_tokens)

    common = Counter(p_tokens) & Counter(g_tokens)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0

    precision = overlap / len(p_tokens)
    recall = overlap / len(g_tokens)
    return 2 * precision * recall / (precision + recall)


def containment(pred: str, gold: str) -> float:
    """
    Fraction of gold tokens present in the prediction.

    Reported alongside F1 because a prediction that quotes the whole
    surrounding paragraph scores badly on F1 (it is too long) while still
    containing the entire correct clause. Distinguishing "too broad" from
    "plain wrong" matters when deciding what to fix.
    """
    p_tokens = tokens(pred)
    g_tokens = tokens(gold)
    if not g_tokens:
        return 0.0
    common = Counter(p_tokens) & Counter(g_tokens)
    return sum(common.values()) / len(g_tokens)


# ===================================================================
# Database access
# ===================================================================

GOLD_SQL = """
    SELECT pdf_filename, clause_type, expected_text
    FROM gold_labels
    WHERE source = 'cuad'
      AND split = %s
      AND is_absent = FALSE
      AND expected_text IS NOT NULL;
"""

# Only documents that actually exist in `documents` can be scored. The join
# on filename is exact - a mismatch here means the corpus drifted, and the
# coverage line in the report will show it.
PRED_SQL = """
    SELECT d.filename,
           c.clause_type,
           c.clause_text,
           c.is_absent,
           c.confidence,
           c.risk_score,
           c.review_status,
           c.extracted_fields->>'attribution'  AS attribution,
           c.extracted_fields->>'verbatim_ok'  AS verbatim_ok
    FROM clauses c
    JOIN documents d ON d.id = c.document_id
    WHERE d.filename IN (
        SELECT DISTINCT pdf_filename
        FROM gold_labels
        WHERE source = 'cuad' AND split = %s
    );
"""


def fetch(db_url: str, split: str):
    conn = psycopg2.connect(db_url, connect_timeout=15)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(GOLD_SQL, (split,))
                gold_rows = cur.fetchall()

                cur.execute(PRED_SQL, (split,))
                pred_rows = cur.fetchall()
    finally:
        conn.close()
    return gold_rows, pred_rows


# ===================================================================
# Evaluation
# ===================================================================

class PairResult:
    """Everything known about one (contract, clause_type) pair."""

    __slots__ = (
        "filename", "clause_type", "gold_spans", "preds",
        "best_f1", "best_containment", "best_pred", "predicted_absent",
        "no_prediction", "detected",
    )

    def __init__(self, filename, clause_type, gold_spans):
        self.filename = filename
        self.clause_type = clause_type
        self.gold_spans = gold_spans
        self.preds = []
        self.best_f1 = 0.0
        self.best_containment = 0.0
        self.best_pred = None
        self.predicted_absent = False
        self.no_prediction = True
        self.detected = False


def evaluate(gold_rows, pred_rows, threshold: float):
    # ---- group gold by pair -------------------------------------
    gold_by_pair: dict[tuple[str, str], list[str]] = defaultdict(list)
    for filename, clause_type, expected_text in gold_rows:
        gold_by_pair[(filename, clause_type)].append(expected_text)

    # ---- group predictions by pair ------------------------------
    preds_by_pair: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in pred_rows:
        (filename, clause_type, clause_text, is_absent, confidence,
         risk_score, review_status, attribution, verbatim_ok) = row
        preds_by_pair[(filename, clause_type)].append({
            "clause_text": clause_text or "",
            "is_absent": bool(is_absent),
            "confidence": float(confidence) if confidence is not None else None,
            "risk_score": float(risk_score) if risk_score is not None else None,
            "review_status": review_status,
            "attribution": attribution or "unknown",
            "verbatim_ok": verbatim_ok,
        })

    # Only score pairs whose document was actually ingested.
    ingested = {filename for filename, *_ in pred_rows}

    pairs: list[PairResult] = []
    skipped_pairs = 0

    for (filename, clause_type), gold_spans in sorted(gold_by_pair.items()):
        if filename not in ingested:
            skipped_pairs += 1
            continue

        pair = PairResult(filename, clause_type, gold_spans)
        candidates = preds_by_pair.get((filename, clause_type), [])
        pair.preds = candidates

        if candidates:
            pair.no_prediction = False

        asserted = [p for p in candidates if not p["is_absent"]]
        if candidates and not asserted:
            pair.predicted_absent = True

        for p in asserted:
            f1 = max(token_f1(p["clause_text"], g) for g in gold_spans)
            cont = max(containment(p["clause_text"], g) for g in gold_spans)
            p["f1"] = f1
            p["containment"] = cont
            p["correct"] = f1 >= threshold
            # `>=` on the first candidate, so best_pred is populated even when
            # every span scores exactly 0.0 - those are the rows worth reading.
            if pair.best_pred is None or f1 > pair.best_f1:
                pair.best_f1 = f1
                pair.best_containment = cont
                pair.best_pred = p

        pair.detected = pair.best_f1 >= threshold
        pairs.append(pair)

    return pairs, skipped_pairs


def summarise(pairs, threshold):
    """Overall and per-clause-type metrics."""
    def block(subset):
        total = len(subset)
        if total == 0:
            return None
        detected = sum(1 for p in subset if p.detected)
        absent_asserted = sum(1 for p in subset if p.predicted_absent)
        no_pred = sum(1 for p in subset if p.no_prediction)

        spans = [s for p in subset for s in p.preds if not s["is_absent"]]
        correct_spans = sum(1 for s in spans if s.get("correct"))

        return {
            "pairs": total,
            "detected": detected,
            "recall": detected / total,
            "spans": len(spans),
            "correct_spans": correct_spans,
            "precision": (correct_spans / len(spans)) if spans else 0.0,
            "mean_f1": sum(p.best_f1 for p in subset) / total,
            "mean_containment": sum(p.best_containment for p in subset) / total,
            "predicted_absent": absent_asserted,
            "no_prediction": no_pred,
        }

    overall = block(pairs)

    by_type = {}
    for clause_type in sorted({p.clause_type for p in pairs}):
        by_type[clause_type] = block([p for p in pairs if p.clause_type == clause_type])

    return overall, by_type


def attribution_table(pairs, threshold):
    """
    Match rate grouped by the model's self-reported attribution.

    This is the table that justifies routing human review on attribution
    rather than on confidence: 'not_found' should show a far lower match
    rate than 'model' or 'recovered'.
    """
    buckets = defaultdict(lambda: {"n": 0, "correct": 0, "f1_sum": 0.0})
    for p in pairs:
        for s in p.preds:
            if s["is_absent"]:
                key = "is_absent=true"
                buckets[key]["n"] += 1
                continue
            key = s["attribution"]
            buckets[key]["n"] += 1
            buckets[key]["f1_sum"] += s.get("f1", 0.0)
            if s.get("correct"):
                buckets[key]["correct"] += 1
    return buckets


def confidence_table(pairs, threshold):
    """
    Match rate grouped by the model's self-reported confidence.

    If the match rate is flat across confidence bands, self-reported
    confidence carries no signal - which is the documented finding that
    drove WF4's routing design.
    """
    bands = [
        ("0.00-0.49", 0.00, 0.50),
        ("0.50-0.69", 0.50, 0.70),
        ("0.70-0.84", 0.70, 0.85),
        ("0.85-1.00", 0.85, 1.01),
    ]
    buckets = {label: {"n": 0, "correct": 0, "f1_sum": 0.0} for label, _, _ in bands}
    buckets["no confidence"] = {"n": 0, "correct": 0, "f1_sum": 0.0}

    for p in pairs:
        for s in p.preds:
            if s["is_absent"]:
                continue
            c = s["confidence"]
            if c is None:
                key = "no confidence"
            else:
                key = next((lbl for lbl, lo, hi in bands if lo <= c < hi), "0.85-1.00")
            buckets[key]["n"] += 1
            buckets[key]["f1_sum"] += s.get("f1", 0.0)
            if s.get("correct"):
                buckets[key]["correct"] += 1
    return buckets


# ===================================================================
# Reporting
# ===================================================================

def pct(x: float) -> str:
    return f"{100 * x:5.1f}%"


def print_report(split, threshold, overall, by_type, attrib, conf,
                 skipped_pairs, n_docs, n_gold_rows):
    line = "=" * 74
    print("\n" + line)
    print(f"  EVALUATION - split '{split}'   (match threshold: token F1 >= {threshold:.2f})")
    print(line)

    print(f"\n  documents scored        : {n_docs}")
    print(f"  gold spans loaded       : {n_gold_rows}")
    print(f"  pairs scored            : {overall['pairs']}")
    if skipped_pairs:
        print(f"  pairs skipped           : {skipped_pairs}  "
              f"(contract in gold but not ingested)")

    print("\n  " + "-" * 70)
    print("  HEADLINE")
    print("  " + "-" * 70)
    print(f"    detection recall      : {pct(overall['recall'])}   "
          f"({overall['detected']}/{overall['pairs']} pairs found)")
    print(f"    span precision        : {pct(overall['precision'])}   "
          f"({overall['correct_spans']}/{overall['spans']} spans correct)")
    print(f"    mean best token F1    : {overall['mean_f1']:.3f}")
    print(f"    mean gold containment : {overall['mean_containment']:.3f}")
    print(f"    pairs called absent   : {overall['predicted_absent']}  "
          f"(all are misses - gold has no absent pairs)")
    print(f"    pairs with no output  : {overall['no_prediction']}")

    print("\n  " + "-" * 70)
    print("  BY CLAUSE TYPE")
    print("  " + "-" * 70)
    print(f"    {'clause type':<30}{'pairs':>6}{'recall':>9}{'prec':>9}{'mean F1':>9}")
    for clause_type, b in by_type.items():
        print(f"    {clause_type:<30}{b['pairs']:>6}{pct(b['recall']):>9}"
              f"{pct(b['precision']):>9}{b['mean_f1']:>9.3f}")

    print("\n  " + "-" * 70)
    print("  BY ATTRIBUTION  (why review routes on evidence)")
    print("  " + "-" * 70)
    print(f"    {'attribution':<20}{'spans':>7}{'match rate':>13}{'mean F1':>10}")
    for key in sorted(attrib):
        b = attrib[key]
        if b["n"] == 0:
            continue
        if key == "is_absent=true":
            print(f"    {key:<20}{b['n']:>7}{'0.0%':>13}{'-':>10}")
        else:
            print(f"    {key:<20}{b['n']:>7}"
                  f"{pct(b['correct'] / b['n']):>13}"
                  f"{b['f1_sum'] / b['n']:>10.3f}")

    print("\n  " + "-" * 70)
    print("  BY SELF-REPORTED CONFIDENCE  (why review does NOT route on this)")
    print("  " + "-" * 70)
    print(f"    {'confidence band':<20}{'spans':>7}{'match rate':>13}{'mean F1':>10}")
    for key, b in conf.items():
        if b["n"] == 0:
            continue
        print(f"    {key:<20}{b['n']:>7}"
              f"{pct(b['correct'] / b['n']):>13}"
              f"{b['f1_sum'] / b['n']:>10.3f}")

    print("\n" + line + "\n")


def write_markdown(path, split, threshold, overall, by_type, attrib, conf,
                   skipped_pairs, n_docs, n_gold_rows):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    L = []
    L.append("# Evaluation")
    L.append("")
    L.append(f"Generated {ts} by `scripts/evaluate.py`.")
    L.append("")
    L.append(f"- Split: **{split}**")
    L.append(f"- Documents scored: **{n_docs}**")
    L.append(f"- Pairs scored: **{overall['pairs']}** "
             f"(one per contract x clause type)")
    L.append(f"- Gold spans: **{n_gold_rows}** (CUAD only; lawyer corrections excluded)")
    L.append(f"- Match rule: token-level F1 >= **{threshold:.2f}** against the "
             f"best gold span for that pair")
    if skipped_pairs:
        L.append(f"- Pairs skipped: **{skipped_pairs}** (contract present in gold "
                 f"but not yet ingested)")
    L.append("")
    L.append("## Headline")
    L.append("")
    L.append("| Metric | Value |")
    L.append("|---|---|")
    L.append(f"| Detection recall | **{pct(overall['recall']).strip()}** "
             f"({overall['detected']}/{overall['pairs']}) |")
    L.append(f"| Span precision | **{pct(overall['precision']).strip()}** "
             f"({overall['correct_spans']}/{overall['spans']}) |")
    L.append(f"| Mean best token F1 | {overall['mean_f1']:.3f} |")
    L.append(f"| Mean gold containment | {overall['mean_containment']:.3f} |")
    L.append(f"| Pairs the system called absent | {overall['predicted_absent']} |")
    L.append(f"| Pairs with no output at all | {overall['no_prediction']} |")
    L.append("")
    L.append("## By clause type")
    L.append("")
    L.append("| Clause type | Pairs | Recall | Span precision | Mean F1 |")
    L.append("|---|---:|---:|---:|---:|")
    for clause_type, b in by_type.items():
        L.append(f"| {clause_type} | {b['pairs']} | {pct(b['recall']).strip()} | "
                 f"{pct(b['precision']).strip()} | {b['mean_f1']:.3f} |")
    L.append("")
    L.append("## Match rate by attribution")
    L.append("")
    L.append("The model tags each extraction with how it found the text. "
             "`not_found` means it could not locate a verbatim span. "
             "Human review routes on this signal.")
    L.append("")
    L.append("| Attribution | Spans | Match rate | Mean F1 |")
    L.append("|---|---:|---:|---:|")
    for key in sorted(attrib):
        b = attrib[key]
        if b["n"] == 0:
            continue
        if key == "is_absent=true":
            L.append(f"| {key} | {b['n']} | 0.0% | - |")
        else:
            L.append(f"| {key} | {b['n']} | {pct(b['correct'] / b['n']).strip()} | "
                     f"{b['f1_sum'] / b['n']:.3f} |")
    L.append("")
    L.append("## Match rate by self-reported confidence")
    L.append("")
    L.append("Confidence is what the model claims about its own output. "
             "A flat match rate across bands means the number carries no usable "
             "signal, which is why review is not routed on it.")
    L.append("")
    L.append("| Confidence band | Spans | Match rate | Mean F1 |")
    L.append("|---|---:|---:|---:|")
    for key, b in conf.items():
        if b["n"] == 0:
            continue
        L.append(f"| {key} | {b['n']} | {pct(b['correct'] / b['n']).strip()} | "
                 f"{b['f1_sum'] / b['n']:.3f} |")
    L.append("")
    L.append("## How to read these numbers")
    L.append("")
    L.append("**Matching is on text, not offsets.** `gold_labels.answer_start` "
             "indexes into CUAD's own extraction of the contract; `clauses.char_start` "
             "indexes into this pipeline's. The two extractors disagree about "
             "whitespace and page furniture, so offsets are not comparable and "
             "were not used.")
    L.append("")
    L.append("**There are no true negatives.** `prepare_dataset.py` selected "
             "contracts that contain all five clause types, so every gold pair is "
             "present. This evaluation therefore cannot measure clauses "
             "hallucinated where none exist, and does not claim to. Every span the "
             "system marked absent is counted as a miss.")
    L.append("")
    L.append("**Span precision is not document-level precision.** It answers: of "
             "the spans the system asserted, how many actually matched the "
             "lawyer-annotated text? A span naming the right clause type but "
             "quoting the wrong paragraph counts against it.")
    L.append("")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(L), encoding="utf-8")


def print_misses(pairs, threshold, limit):
    print("\n" + "=" * 74)
    print(f"  WORST {limit} PAIRS  (lowest best-F1)")
    print("=" * 74)
    worst = sorted(pairs, key=lambda p: p.best_f1)[:limit]
    for p in worst:
        print(f"\n  {p.clause_type}  |  {p.filename[:60]}")
        print(f"    best F1: {p.best_f1:.3f}   containment: {p.best_containment:.3f}")
        if p.no_prediction:
            print("    -> the pipeline produced no row for this pair at all")
        elif p.predicted_absent:
            print("    -> the pipeline asserted the clause is absent")
        else:
            attr = p.best_pred["attribution"] if p.best_pred else "?"
            conf = p.best_pred["confidence"] if p.best_pred else None
            print(f"    attribution: {attr}   confidence: {conf}")
            print(f"    PREDICTED: {(p.best_pred['clause_text'] or '')[:220]!r}")
        print(f"    GOLD     : {p.gold_spans[0][:220]!r}")


# ===================================================================
# Entry point
# ===================================================================

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Score extracted clauses against CUAD gold labels."
    )
    ap.add_argument(
        "--split", default="dev", choices=["dev", "holdout"],
        help="Which split to score. Default dev. Use holdout only in Phase 4.",
    )
    ap.add_argument(
        "--threshold", type=float, default=DEFAULT_THRESHOLD,
        help=f"Token F1 at which a span counts as correct. Default {DEFAULT_THRESHOLD}.",
    )
    ap.add_argument(
        "--show-misses", type=int, default=0, metavar="N",
        help="Print the N worst pairs with their text. Refused for holdout.",
    )
    ap.add_argument(
        "--no-report", action="store_true",
        help="Skip writing docs/evaluation.md.",
    )
    args = ap.parse_args()

    if args.split == "holdout" and args.show_misses:
        print("REFUSED: --show-misses prints contract text and would expose the")
        print("holdout set. Inspect misses on dev; report holdout as numbers only.")
        return 1

    if not ENV_PATH.is_file():
        print(f"ERROR: no .env file at {ENV_PATH}")
        return 1

    load_dotenv(ENV_PATH)
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL is not set in .env")
        return 1

    print(f"Connecting to database (split '{args.split}')...")
    try:
        gold_rows, pred_rows = fetch(db_url, args.split)
    except psycopg2.OperationalError as exc:
        print(f"FAILED to connect: {exc}")
        print("Run  python scripts/test_connection.py  to diagnose.")
        return 1
    except psycopg2.errors.UndefinedColumn as exc:
        print(f"FAILED: {exc}")
        print("Likely cause: gold_labels has no `source` column, or clauses has")
        print("no `is_absent` / `risk_score`. Check the applied migrations.")
        return 1
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}")
        return 1

    if not gold_rows:
        print(f"ERROR: no CUAD gold labels found for split '{args.split}'.")
        print("Fix: run  python scripts/load_gold_labels.py")
        return 1

    if not pred_rows:
        print(f"ERROR: no clauses found for any '{args.split}' contract.")
        print("Nothing has been ingested and analysed yet, so there is nothing")
        print("to score. Run the pipeline first.")
        return 1

    pairs, skipped = evaluate(gold_rows, pred_rows, args.threshold)
    if not pairs:
        print("ERROR: no scorable pairs. Gold filenames and documents.filename")
        print("do not overlap - the corpus filenames have drifted.")
        return 1

    overall, by_type = summarise(pairs, args.threshold)
    attrib = attribution_table(pairs, args.threshold)
    conf = confidence_table(pairs, args.threshold)

    n_docs = len({p.filename for p in pairs})

    print_report(args.split, args.threshold, overall, by_type, attrib, conf,
                 skipped, n_docs, len(gold_rows))

    if args.show_misses:
        print_misses(pairs, args.threshold, args.show_misses)

    if not args.no_report:
        write_markdown(REPORT_PATH, args.split, args.threshold, overall, by_type,
                       attrib, conf, skipped, n_docs, len(gold_rows))
        print(f"Report written to {REPORT_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
