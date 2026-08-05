"""
Select the working corpus from CUAD and build the dev / holdout split.

What this does
--------------
1. Finds every contract that contains ALL FIVE target clause types.
2. Sorts them alphabetically and takes the first 30.
   Alphabetical, not random: no seed to lose, identical result on any machine.
3. Splits them 20 dev / 10 holdout.
4. Copies each contract's PDF into data/prepared/dev or data/prepared/holdout.
5. Writes data/prepared/gold_labels.json - the expert answer key for Phase 4.

THE HOLDOUT RULE
----------------
The 10 holdout contracts must not be opened, read, or used for prompt tuning
until Phase 4. This script copies them and records their labels, but never
prints their text. Tuning against holdout data makes the final precision and
recall numbers self-graded and worthless.

Re-runnable
-----------
Safe to run repeatedly. Copies overwrite, JSON is rewritten, nothing is
duplicated or appended.

Place at:  <project root>/scripts/prepare_dataset.py
Run from:  <project root>   ->   python scripts/prepare_dataset.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

# --- Paths, resolved relative to this file so no machine-specific strings ---
PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CUAD = PROJECT_ROOT / "data" / "raw" / "CUAD_v1.json"
CUAD_JSON = Path(os.getenv("CUAD_JSON_PATH", str(DEFAULT_CUAD)))
PDF_ROOT = PROJECT_ROOT / "data" / "raw" / "full_contract_pdf"

PREPARED = PROJECT_ROOT / "data" / "prepared"
DEV_DIR = PREPARED / "dev"
HOLDOUT_DIR = PREPARED / "holdout"
GOLD_JSON = PREPARED / "gold_labels.json"
MANIFEST_JSON = PREPARED / "split_manifest.json"

# --- Locked project decisions ---
TARGET_CATEGORIES = [
    "Governing Law",
    "Termination For Convenience",
    "Cap On Liability",
    "Renewal Term",
    "Anti-Assignment",
]
DEV_COUNT = 20
HOLDOUT_COUNT = 10
TOTAL_NEEDED = DEV_COUNT + HOLDOUT_COUNT

# Windows refuses paths beyond 260 characters. CUAD filenames are long.
WINDOWS_PATH_WARN = 240


def category_of(qa: dict) -> str:
    """Extract the clause category from a CUAD question-answer entry."""
    qid = qa.get("id", "")
    if "__" in qid:
        return qid.rsplit("__", 1)[-1].strip()
    parts = qa.get("question", "").split('"')
    return parts[1].strip() if len(parts) >= 2 else "UNKNOWN"


def normalise(name: str) -> str:
    """
    Reduce a filename or title to a comparable key.

    CUAD titles and PDF filenames differ in punctuation, spacing and case
    (e.g. 'CO-BRANDING AGREEMENT' vs 'Co_Branding_Agreement'). Stripping
    everything except letters and digits makes the match reliable.
    """
    return re.sub(r"[^a-z0-9]", "", name.lower())


def build_pdf_index(pdf_root: Path) -> dict[str, Path]:
    """Map every PDF under pdf_root to a normalised lookup key."""
    index: dict[str, Path] = {}
    for path in pdf_root.rglob("*"):
        if path.is_file() and path.suffix.lower() == ".pdf":
            index.setdefault(normalise(path.stem), path)
    return index


def main() -> int:
    # ---------- Preconditions ----------
    if not CUAD_JSON.is_file():
        print(f"ERROR: CUAD file not found at {CUAD_JSON}")
        return 1

    if not PDF_ROOT.is_dir():
        print(f"ERROR: PDF folder not found at {PDF_ROOT}")
        print("Expected data/raw/full_contract_pdf/Part_I ... Part_IV")
        return 1

    print("Indexing PDFs...")
    pdf_index = build_pdf_index(PDF_ROOT)
    print(f"  found {len(pdf_index)} PDF files")

    if not pdf_index:
        print("ERROR: no PDFs found. Check that Part_I..Part_IV were extracted.")
        return 1

    print(f"Reading {CUAD_JSON.name}...")
    with CUAD_JSON.open("r", encoding="utf-8") as f:
        contracts = json.load(f)["data"]

    # ---------- Step 1: which contracts have all five clause types ----------
    needed = set(TARGET_CATEGORIES)
    # labels_by_title[title][category] = list of {text, answer_start}
    labels_by_title: dict[str, dict[str, list[dict]]] = {}

    for contract in contracts:
        title = contract.get("title", "")
        found: dict[str, list[dict]] = {}

        for para in contract.get("paragraphs", []):
            for qa in para.get("qas", []):
                cat = category_of(qa)
                if cat not in needed:
                    continue
                if qa.get("is_impossible", False):
                    continue
                answers = qa.get("answers", [])
                if not answers:
                    continue
                found.setdefault(cat, []).extend(
                    {
                        "text": a.get("text", ""),
                        "answer_start": int(a.get("answer_start", -1)),
                    }
                    for a in answers
                )

        if needed.issubset(found.keys()):
            labels_by_title[title] = found

    print(f"Contracts containing all five clause types: {len(labels_by_title)}")

    # ---------- Step 2: keep only those whose PDF actually exists ----------
    usable: list[tuple[str, Path]] = []
    missing: list[str] = []

    for title in sorted(labels_by_title):          # alphabetical = reproducible
        pdf = pdf_index.get(normalise(title))
        if pdf is None:
            missing.append(title)
        else:
            usable.append((title, pdf))

    print(f"Of those, PDFs located for: {len(usable)}")
    if missing:
        print(f"  ({len(missing)} skipped - no matching PDF found)")

    if len(usable) < TOTAL_NEEDED:
        print(f"\nERROR: need {TOTAL_NEEDED} contracts, only {len(usable)} usable.")
        return 1

    selected = usable[:TOTAL_NEEDED]
    dev_set = selected[:DEV_COUNT]
    holdout_set = selected[DEV_COUNT:]

    # ---------- Step 3: copy PDFs ----------
    for folder in (DEV_DIR, HOLDOUT_DIR):
        folder.mkdir(parents=True, exist_ok=True)

    def copy_all(pairs: list[tuple[str, Path]], dest: Path) -> list[str]:
        names: list[str] = []
        for title, src in pairs:
            target = dest / src.name
            if len(str(target)) > WINDOWS_PATH_WARN:
                print(f"  WARNING: long path ({len(str(target))} chars): {src.name}")
            shutil.copy2(src, target)     # overwrite = re-runnable
            names.append(src.name)
        return names

    print(f"\nCopying {DEV_COUNT} PDFs to data/prepared/dev/ ...")
    dev_files = copy_all(dev_set, DEV_DIR)

    print(f"Copying {HOLDOUT_COUNT} PDFs to data/prepared/holdout/ ...")
    holdout_files = copy_all(holdout_set, HOLDOUT_DIR)

    # ---------- Step 4: write the gold label answer key ----------
    gold_rows: list[dict] = []

    def add_rows(pairs: list[tuple[str, Path]], split: str) -> None:
        for title, src in pairs:
            for clause_type in TARGET_CATEGORIES:
                for span in labels_by_title[title][clause_type]:
                    gold_rows.append(
                        {
                            "contract_title": title,
                            "pdf_filename": src.name,
                            "split": split,
                            "clause_type": clause_type,
                            "expected_text": span["text"],
                            "answer_start": span["answer_start"],
                            "is_absent": False,
                        }
                    )

    add_rows(dev_set, "dev")
    add_rows(holdout_set, "holdout")

    GOLD_JSON.write_text(json.dumps(gold_rows, indent=2), encoding="utf-8")

    manifest = {
        "source": CUAD_JSON.name,
        "selection_rule": "contracts containing all 5 target clause types",
        "ordering": "alphabetical by contract title (deterministic, no seed)",
        "target_categories": TARGET_CATEGORIES,
        "dev": dev_files,
        "holdout": holdout_files,
    }
    MANIFEST_JSON.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # ---------- Summary ----------
    dev_rows = sum(1 for r in gold_rows if r["split"] == "dev")
    holdout_rows = len(gold_rows) - dev_rows

    print("\n" + "-" * 60)
    print(f"  dev PDFs         : {len(dev_files)}")
    print(f"  holdout PDFs     : {len(holdout_files)}   <-- do not open until Phase 4")
    print(f"  gold label rows  : {len(gold_rows)}  (dev {dev_rows} / holdout {holdout_rows})")
    print(f"  answer key       : {GOLD_JSON.relative_to(PROJECT_ROOT)}")
    print(f"  split manifest   : {MANIFEST_JSON.relative_to(PROJECT_ROOT)}")
    print("-" * 60)
    print("\nDev contracts selected:")
    for name in dev_files:
        print(f"  {name}")
    print("\nHoldout: 10 files copied. Names withheld here on purpose -")
    print("see split_manifest.json in Phase 4.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
