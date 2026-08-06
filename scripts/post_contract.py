"""
Post one or more contract PDFs to the WF1 ingestion webhook.

Why this exists
---------------
CUAD filenames contain commas, spaces, and periods. curl's -F flag treats
commas as field separators, and Windows PowerShell 5.1 mangles the quoting
needed to escape them. Python's requests library builds the multipart body
directly, so no shell parsing is involved and any filename works.

Usage
-----
  python scripts/post_contract.py --index 2          # one file by position
  python scripts/post_contract.py --all              # every dev PDF
  python scripts/post_contract.py --file "path.pdf"  # a specific file

The webhook URL comes from .env (INGEST_WEBHOOK_URL) so this works against
a deployed n8n, not just localhost.
"""

import argparse
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEV_DIR = PROJECT_ROOT / "data" / "prepared" / "dev"

load_dotenv(PROJECT_ROOT / ".env")

DEFAULT_URL = "http://localhost:5678/webhook-test/ingest-contract"
WEBHOOK_URL = os.getenv("INGEST_WEBHOOK_URL", DEFAULT_URL)


def post_pdf(path: Path) -> bool:
    """Send one PDF. Returns True if the server accepted or deduped it."""
    print(f"\n-> {path.name}")

    try:
        with path.open("rb") as fh:
            files = {"file": (path.name, fh, "application/pdf")}
            resp = requests.post(WEBHOOK_URL, files=files, timeout=120)
    except requests.exceptions.ConnectionError:
        print("   FAILED - cannot reach n8n.")
        print("   Is the container running, and did you click "
              "'Execute workflow' for a /webhook-test/ URL?")
        return False
    except requests.exceptions.Timeout:
        print("   FAILED - no response within 120s.")
        return False

    print(f"   HTTP {resp.status_code}")

    try:
        body = resp.json()
        for key, value in body.items():
            print(f"   {key}: {value}")
    except ValueError:
        print(f"   {resp.text[:300]}")

    return resp.status_code in (200, 202)


def main() -> int:
    ap = argparse.ArgumentParser()
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--index", type=int,
                       help="0-based position in the dev folder")
    group.add_argument("--all", action="store_true",
                       help="post every dev PDF")
    group.add_argument("--file", type=str,
                       help="path to a specific PDF")
    args = ap.parse_args()

    print(f"Webhook: {WEBHOOK_URL}")

    if args.file:
        targets = [Path(args.file)]
    else:
        if not DEV_DIR.exists():
            print(f"ERROR: {DEV_DIR} not found. Run prepare_dataset.py first.")
            return 1
        pdfs = sorted(DEV_DIR.glob("*.pdf"))
        if not pdfs:
            print(f"ERROR: no PDFs in {DEV_DIR}")
            return 1
        if args.all:
            targets = pdfs
        else:
            if args.index < 0 or args.index >= len(pdfs):
                print(f"ERROR: --index must be 0..{len(pdfs) - 1}")
                return 1
            targets = [pdfs[args.index]]

    ok = 0
    for pdf in targets:
        if not pdf.exists():
            print(f"\n-> {pdf}\n   FAILED - file not found")
            continue
        if post_pdf(pdf):
            ok += 1

    print(f"\n{'-' * 50}")
    print(f"  {ok} / {len(targets)} succeeded")
    return 0 if ok == len(targets) else 1


if __name__ == "__main__":
    sys.exit(main())