"""
Inspect the CUAD dataset and report how many contracts contain each clause category.

Why this exists:
  Assignment 11 extracts exactly 5 clause types. A category is only usable if it
  appears in enough contracts that we can find 30 contracts containing ALL five.
  This script measures that instead of guessing.

Reads:  data/raw/CUAD_v1.json  (override with the CUAD_JSON_PATH env var)
Writes: data/prepared/cuad_category_counts.json  (overwritten each run)

Place at:  <project root>/scripts/inspect_cuad.py
Run from:  <project root>   ->   python scripts/inspect_cuad.py
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

# --- Paths: resolved relative to this file, never hardcoded to one machine ---
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CUAD = PROJECT_ROOT / "data" / "raw" / "CUAD_v1.json"
CUAD_JSON = Path(os.getenv("CUAD_JSON_PATH", str(DEFAULT_CUAD)))
OUT_JSON = PROJECT_ROOT / "data" / "prepared" / "cuad_category_counts.json"

# --- Policy values from the project instructions ---
TARGET_CATEGORIES = [
    "Governing Law",
    "Termination For Convenience",
    "Cap On Liability",
    "Renewal Term",
    "Anti-Assignment",
]
MIN_CONTRACTS_PER_CATEGORY = 150   # selection rule
CONTRACTS_NEEDED = 30              # 20 dev + 10 holdout


def category_of(qa: dict) -> str:
    """
    Get the clause category name from one question-answer entry.

    CUAD question ids look like:
        SOME_CONTRACT_NAME__Governing Law
    so the text after the last '__' is the category. If that fails, fall back to
    the quoted phrase inside the question text.
    """
    qid = qa.get("id", "")
    if "__" in qid:
        return qid.rsplit("__", 1)[-1].strip()

    question = qa.get("question", "")
    parts = question.split('"')
    if len(parts) >= 2:
        return parts[1].strip()

    return "UNKNOWN"


def has_answer(qa: dict) -> bool:
    """True if this clause is actually present in this contract."""
    if qa.get("is_impossible", False):
        return False
    return len(qa.get("answers", [])) > 0


def main() -> int:
    if not CUAD_JSON.is_file():
        print(f"ERROR: CUAD file not found at: {CUAD_JSON}")
        print("Fix: put CUAD_v1.json in data/raw/, or set CUAD_JSON_PATH.")
        return 1

    size_mb = CUAD_JSON.stat().st_size / (1024 * 1024)
    print(f"Reading {CUAD_JSON.name} ({size_mb:.1f} MB) - this can take ~10-60 seconds...")

    with CUAD_JSON.open("r", encoding="utf-8") as f:
        data = json.load(f)["data"]

    # contracts_with[category] = number of contracts containing that clause
    contracts_with = Counter()
    # spans_total[category] = number of annotated text spans (a contract can have several)
    spans_total = Counter()
    # cats_per_contract[title] = set of categories present in that contract
    cats_per_contract: dict[str, set[str]] = defaultdict(set)

    for contract in data:
        title = contract.get("title", "<untitled>")
        # make sure every contract appears in the map, even if it has no answers
        _ = cats_per_contract[title]
        for para in contract.get("paragraphs", []):
            for qa in para.get("qas", []):
                cat = category_of(qa)
                if has_answer(qa):
                    spans_total[cat] += len(qa.get("answers", []))
                    if cat not in cats_per_contract[title]:
                        cats_per_contract[title].add(cat)
                        contracts_with[cat] += 1
                else:
                    # make sure zero-answer categories still show up in the report
                    contracts_with.setdefault(cat, 0)

    total_contracts = len(cats_per_contract)
    all_categories = sorted(contracts_with, key=lambda c: (-contracts_with[c], c))

    # ---------- Report 1: every category, most common first ----------
    print()
    print(f"Contracts parsed: {total_contracts}")
    print(f"Categories found: {len(all_categories)}")
    print()
    print(f"{'#':>3}  {'CATEGORY':<45} {'CONTRACTS':>9} {'PCT':>6} {'SPANS':>7}")
    print("-" * 76)
    for i, cat in enumerate(all_categories, start=1):
        n = contracts_with[cat]
        pct = (100.0 * n / total_contracts) if total_contracts else 0.0
        print(f"{i:>3}  {cat:<45} {n:>9} {pct:>5.1f}% {spans_total[cat]:>7}")

    # ---------- Report 2: the five target categories ----------
    lookup = {c.lower(): c for c in all_categories}
    print()
    print(f"TARGET FIVE (rule: needs {MIN_CONTRACTS_PER_CATEGORY}+ contracts)")
    print("-" * 76)

    resolved: list[str] = []
    for wanted in TARGET_CATEGORIES:
        actual = lookup.get(wanted.lower())
        if actual is None:
            print(f"  NOT FOUND  {wanted:<40} (check exact CUAD spelling below)")
            near = [c for c in all_categories if wanted.split()[0].lower() in c.lower()]
            for c in near:
                print(f"             possible match -> {c}")
            continue
        resolved.append(actual)
        n = contracts_with[actual]
        verdict = "OK" if n >= MIN_CONTRACTS_PER_CATEGORY else "LOW"
        print(f"  {verdict:<10} {actual:<40} {n:>5} contracts")

    # ---------- Report 3: the number that actually matters ----------
    if len(resolved) == len(TARGET_CATEGORIES):
        needed = set(resolved)
        both = [t for t, cats in cats_per_contract.items() if needed.issubset(cats)]
        print()
        print(f"Contracts containing ALL FIVE: {len(both)}  (need {CONTRACTS_NEEDED})")
        print("VERDICT:", "PASS" if len(both) >= CONTRACTS_NEEDED else "FAIL - swap a category")

        if len(both) < CONTRACTS_NEEDED:
            print()
            print("Leave-one-out: contracts remaining if you DROP each category")
            for drop in resolved:
                rest = needed - {drop}
                cnt = sum(1 for cats in cats_per_contract.values() if rest.issubset(cats))
                print(f"  drop {drop:<40} -> {cnt:>4} contracts")

    # ---------- Save machine-readable summary ----------
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    summary = {
        "source_file": CUAD_JSON.name,
        "total_contracts": total_contracts,
        "categories": [
            {"name": c, "contracts": contracts_with[c], "spans": spans_total[c]}
            for c in all_categories
        ],
    }
    OUT_JSON.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"\nSummary written to: {OUT_JSON.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
