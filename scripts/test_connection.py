"""
Verify that DATABASE_URL in .env points to a working PostgreSQL database.

Why this exists:
  Connection problems produce misleading errors. A wrong pooler host looks
  like a network outage; a symbol in the password looks like a wrong password.
  This script tests the connection and explains what actually went wrong.

Run this first whenever anything database-related breaks.

Place at:  <project root>/scripts/test_connection.py
Run from:  <project root>   ->   python scripts/test_connection.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlparse

try:
    import psycopg2
except ImportError:
    print("ERROR: psycopg2 is not installed.")
    print("Fix: pip install -r requirements.txt")
    sys.exit(1)

try:
    from dotenv import load_dotenv
except ImportError:
    print("ERROR: python-dotenv is not installed.")
    print("Fix: pip install -r requirements.txt")
    sys.exit(1)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = PROJECT_ROOT / ".env"


def mask(url: str) -> str:
    """Return the URL with the password replaced, so it is safe to print."""
    try:
        parsed = urlparse(url)
        if parsed.password:
            return url.replace(parsed.password, "********")
    except Exception:
        pass
    return url


def check_url_shape(url: str) -> list[str]:
    """
    Look for the mistakes that cause confusing errors later.
    Returns a list of warning strings (empty list means nothing suspicious).
    """
    warnings: list[str] = []
    parsed = urlparse(url)

    host = parsed.hostname or ""
    port = parsed.port

    if not url.startswith("postgresql://"):
        warnings.append("URL does not start with 'postgresql://'.")

    if "pooler.supabase.com" not in host:
        warnings.append(
            f"Host is '{host}', which is not the Session pooler.\n"
            "     The direct-connection host is IPv6-only on the free tier and\n"
            "     will fail from Docker and most home networks.\n"
            "     Use: Supabase Dashboard -> Connect -> Session pooler."
        )

    if port == 6543:
        warnings.append(
            "Port is 6543 (Transaction pooler). That mode disables prepared\n"
            "     statements, which psycopg2 uses by default. Use port 5432."
        )
    elif port != 5432:
        warnings.append(f"Port is {port}; expected 5432 for the Session pooler.")

    if "[YOUR-PASSWORD]" in url or "FAKEpassword" in url:
        warnings.append("The password is still a placeholder. Paste the real one.")

    # A URL is parsed by delimiters. These characters inside a password break it.
    password = parsed.password or ""
    bad_chars = [c for c in "#?@/:[] " if c in password]
    if bad_chars:
        warnings.append(
            f"Password contains URL-breaking characters: {' '.join(bad_chars)}\n"
            "     Reset it in Supabase to an alphanumeric-only password."
        )

    return warnings


def main() -> int:
    if not ENV_PATH.is_file():
        print(f"ERROR: no .env file found at {ENV_PATH}")
        print("Fix: copy .env.example to .env and fill in real values.")
        return 1

    load_dotenv(ENV_PATH)
    url = os.getenv("DATABASE_URL")

    if not url:
        print("ERROR: DATABASE_URL is not set in .env")
        print("Fix: the line must look like  DATABASE_URL=postgresql://...")
        print("     No spaces around '=', no quotes around the value.")
        return 1

    print(f"Loaded .env from : {ENV_PATH}")
    print(f"DATABASE_URL     : {mask(url)}")
    print()

    warnings = check_url_shape(url)
    if warnings:
        print("WARNINGS about the connection string:")
        for w in warnings:
            print(f"  [!] {w}")
        print()

    print("Connecting...")
    try:
        # connect_timeout stops this hanging for minutes on an unreachable host
        conn = psycopg2.connect(url, connect_timeout=10)
    except psycopg2.OperationalError as exc:
        text = str(exc).strip()
        print(f"FAILED: {text}\n")
        low = text.lower()
        if "password authentication failed" in low:
            print("Likely cause: wrong password, or a symbol in it broke URL parsing.")
            print("Fix: reset to an alphanumeric-only password in Supabase.")
        elif "could not translate host name" in low:
            print("Likely cause: the host name is wrong or you are offline.")
        elif "timeout" in low or "no route" in low or "unreachable" in low:
            print("Likely cause: using the IPv6-only direct connection.")
            print("Fix: switch to the Session pooler string (port 5432).")
        return 1
    except Exception as exc:
        print(f"FAILED with an unexpected error: {type(exc).__name__}: {exc}")
        return 1

    with conn:
        with conn.cursor() as cur:
            cur.execute("SELECT version();")
            version = cur.fetchone()[0]

            cur.execute("SELECT current_database(), current_user;")
            db_name, db_user = cur.fetchone()

            # List tables we have created ourselves (empty on a fresh project)
            cur.execute(
                """
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                ORDER BY table_name;
                """
            )
            tables = [row[0] for row in cur.fetchall()]

    conn.close()

    print("SUCCESS - connected.\n")
    print(f"  Server   : {version.split(',')[0]}")
    print(f"  Database : {db_name}")
    print(f"  User     : {db_user}")

    if tables:
        print(f"  Tables   : {len(tables)} found -> {', '.join(tables)}")
    else:
        print("  Tables   : none yet (expected before schema.sql has been run)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
