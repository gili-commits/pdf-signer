"""גיבוי SQLite בעזרת ה-Online Backup API (אותו מנגנון של `sqlite3 .backup`).

שימוש ידני:
  python -m diet.backup                 # גיבוי עכשיו
  python -m diet.backup --list          # רשימת גיבויים
  python -m diet.backup --restore FILE  # שחזור (כשהאפליקציה עצורה)
"""
import asyncio
import glob
import os
import sqlite3
import sys
from datetime import datetime, timezone

from .db import DB_PATH

BACKUP_DIR = os.environ.get("BACKUP_DIR", "/data/backups")
KEEP = int(os.environ.get("BACKUP_KEEP", "14"))
# 01:00 UTC ≈ 03:00 בישראל (חורף)
HOUR_UTC = int(os.environ.get("BACKUP_HOUR_UTC", "1"))


def _files():
    return sorted(glob.glob(os.path.join(BACKUP_DIR, "diet-*.db")))


def run_backup() -> str:
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    dst = os.path.join(BACKUP_DIR, f"diet-{stamp}.db")
    tmp = dst + ".tmp"
    src = sqlite3.connect(DB_PATH)
    out = sqlite3.connect(tmp)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    os.replace(tmp, dst)
    for old in _files()[:-KEEP]:
        os.remove(old)
    return dst


def _backed_up_today() -> bool:
    today = datetime.now(timezone.utc).strftime("%Y%m%d")
    return any(os.path.basename(f).startswith(f"diet-{today}") for f in _files())


async def nightly_loop():
    while True:
        try:
            if datetime.now(timezone.utc).hour >= HOUR_UTC and not _backed_up_today():
                path = await asyncio.to_thread(run_backup)
                print(f"backup: {path}", flush=True)
        except Exception as e:  # לא להפיל את האפליקציה בגלל גיבוי
            print(f"backup failed: {e}", flush=True)
        await asyncio.sleep(600)


def restore(name: str):
    path = name if os.path.isabs(name) else os.path.join(BACKUP_DIR, name)
    if not os.path.isfile(path):
        sys.exit(f"לא נמצא: {path}")
    src = sqlite3.connect(path)
    if src.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        sys.exit("קובץ הגיבוי פגום")
    out = sqlite3.connect(DB_PATH)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    print(f"שוחזר מ-{path}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--list"]:
        print("\n".join(_files()) or "(אין גיבויים)")
    elif args[:1] == ["--restore"] and len(args) == 2:
        restore(args[1])
    else:
        print(run_backup())
