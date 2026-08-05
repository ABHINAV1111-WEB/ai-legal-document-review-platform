"""
Load the CUAD gold labels into the PostgreSQL `gold_labels` table.

What this does
--------------
Reads data/prepared/gold_labels.json (written by prepare_dataset.py) and
inserts every row into Supabase.

Idempotent by design
--------------------
The table has a UNIQUE constraint on (pdf_filename, clause_type, answer_start).
This script uses ON CONFLICT DO NOTHING, so running it ten times leaves exactly
the same rows as running it once. That matters: duplicated gold labels would
silently inflate the denominator in the Phase 4 recall calculation.

Holdout safety
--------------
Holdout labels ARE loaded, tagged with split='holdout'. Storing them is fine;
the rule is that no query filters on split='holdout' until Phase 4. This script
never prints holdout clause text.

Place at:  <project root>/scripts/load_gold_labels.py
Run from:  <project root>   ->   python scripts/load_gold_labels.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    import psycopg2
    from psycopg2.extras import execute_values
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
GOLD_JSON = PROJECT_ROOT / "data" / "prepared" / "gold_labels.json"

REQUIRED_KEYS = {
    "contract_title",
    "pdf_filename",
    "split",
    "clause_type",
    "expected_text",
    "answer_start",
    "is_absent",
}

INSERT_SQL = """
    INSERT INTO gold_labels (
        contract_title, pdf_filename, split, clause_type,
        expected_text, answer_start, is_absent
    )
    VALUES %s
    ON CONFLICT (pdf_filename, clause_type, answer_start) DO NOTHING;
"""


def main() -> int:
    # ---------- Preconditions ----------
    if not GOLD_JSON.is_file():
        print(f"ERROR: {GOLD_JSON} not found.")
        print("Fix: run  python scripts/prepare_dataset.py  first.")
        return 1

    if not ENV_PATH.is_file():
        print(f"ERROR: no .env file at {ENV_PATH}")
        return 1

    load_dotenv(ENV_PATH)
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL is not set in .env")
        return 1

    # ---------- Read and validate the answer key ----------
    rows = json.loads(GOLD_JSON.read_text(encoding="utf-8"))
    if not rows:
        print("ERROR: gold_labels.json is empty.")
        return 1

    missing = REQUIRED_KEYS - set(rows[0].keys())
    if missing:
        print(f"ERROR: gold_labels.json is missing keys: {sorted(missing)}")
        print("Fix: re-run scripts/prepare_dataset.py")
        return 1

    values = [
        (
            r["contract_title"],
            r["pdf_filename"],
            r["split"],
            r["clause_type"],
            r["expected_text"],
            int(r["answer_start"]),
            bool(r["is_absent"]),
        )
        for r in rows
    ]

    dev_n = sum(1 for r in rows if r["split"] == "dev")
    print(f"Read {len(rows)} labels from gold_labels.json")
    print(f"  dev {dev_n} / holdout {len(rows) - dev_n}")

    # ---------- Insert ----------
    print("\nConnecting to database...")
    try:
        conn = psycopg2.connect(db_url, connect_timeout=10)
    except psycopg2.OperationalError as exc:
        print(f"FAILED to connect: {exc}")
        print("Run  python scripts/test_connection.py  to diagnose.")
        return 1

    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM gold_labels;")
                before = cur.fetchone()[0]

                # page_size batches the insert so one huge statement is avoided
                execute_values(cur, INSERT_SQL, values, page_size=500)

                cur.execute("SELECT COUNT(*) FROM gold_labels;")
                after = cur.fetchone()[0]

                cur.execute(
                    """
                    SELECT split, clause_type, COUNT(*)
                    FROM gold_labels
                    GROUP BY split, clause_type
                    ORDER BY split, clause_type;
                    """
                )
                breakdown = cur.fetchall()

                cur.execute(
                    "SELECT split, COUNT(DISTINCT pdf_filename) "
                    "FROM gold_labels GROUP BY split ORDER BY split;"
                )
                contracts = cur.fetchall()
    except psycopg2.errors.UndefinedTable:
        print("FAILED: the gold_labels table does not exist.")
        print("Fix: run sql/schema.sql in the Supabase SQL editor.")
        return 1
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}")
        return 1
    finally:
        conn.close()

    # ---------- Report ----------
    inserted = after - before
    skipped = len(values) - inserted

    print("\n" + "-" * 58)
    print(f"  rows in table before : {before}")
    print(f"  newly inserted       : {inserted}")
    print(f"  skipped as duplicate : {skipped}")
    print(f"  rows in table now    : {after}")
    print("-" * 58)

    print("\nDistinct contracts per split:")
    for split, n in contracts:
        print(f"  {split:<8} {n:>3}")

    print("\nLabels per split and clause type:")
    for split, clause_type, n in breakdown:
        print(f"  {split:<8} {clause_type:<30} {n:>4}")

    if before > 0 and inserted == 0:
        print("\nNothing new inserted - the table already held these labels.")
        print("That is the expected result of re-running this script.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
