import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from . import plan

DB_PATH = os.environ.get("DB_PATH", "/data/diet.db")
BACKUP_DIR = os.environ.get("BACKUP_DIR", "/data/backups")
SCHEMA_VERSION = 2

# כל הטבלאות נוצרות עם IF NOT EXISTS. שום טבלה או עמודה קיימת לא נמחקת ולא משתנה.
SCHEMA = """
CREATE TABLE IF NOT EXISTS weights(
  date TEXT PRIMARY KEY,
  kg   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS days(
  date       TEXT PRIMARY KEY,
  protein_g  INT  NOT NULL DEFAULT 0,   -- נשמר מסונכרן עם סכום ההזנות (תאימות לאחור)
  protein_ok INT  NOT NULL DEFAULT 0,   -- v1 בלבד; מ-v2 מחושב אוטומטית
  strength   INT  NOT NULL DEFAULT 0,   -- v1 בלבד; מ-v2 ב-day_checks
  cardio     INT  NOT NULL DEFAULT 0,
  fish       INT  NOT NULL DEFAULT 0,
  vitamin_d  INT  NOT NULL DEFAULT 0,
  notes      TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS weeks(
  week      INT  PRIMARY KEY,
  date      TEXT NOT NULL,
  target_kg REAL NOT NULL,
  notes     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS foods(
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  protein_g REAL NOT NULL,
  sort      INT  NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta(
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  expires_at INT  NOT NULL
);
-- v2
CREATE TABLE IF NOT EXISTS entries(
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- protein | sin
  name       TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL,             -- גרם חלבון / קלוריות
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_date ON entries(date);
CREATE TABLE IF NOT EXISTS sin_items(
  id    TEXT PRIMARY KEY,
  emoji TEXT NOT NULL DEFAULT '',
  name  TEXT NOT NULL,
  kcal  REAL NOT NULL,
  sort  INT  NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS checklist_items(
  id    TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort  INT  NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS day_checks(
  date    TEXT NOT NULL,
  item_id TEXT NOT NULL,
  PRIMARY KEY (date, item_id)
);
CREATE TABLE IF NOT EXISTS waist(
  date TEXT PRIMARY KEY,
  cm   REAL NOT NULL
);
-- יועץ: שיחה לכל יום (טבלה חדשה בלבד, אין שינוי בקיימות)
CREATE TABLE IF NOT EXISTS advisor_messages(
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  role        TEXT NOT NULL,            -- user | assistant
  content     TEXT NOT NULL,
  suggestions TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS advisor_date ON advisor_messages(date);
"""

DEFAULT_FOODS = [
    ("d1", "עוף 180 ג׳", 55), ("d2", "טונה", 25), ("d3", "2 ביצים", 13),
    ("d4", "קוטג׳ 100 ג׳", 11), ("d5", "מעדן חלבון", 20), ("d6", "סקייר 200 ג׳", 20),
]
DEFAULT_SINS = [
    ("s1", "🍺", "בירה חצי ליטר", 210), ("s2", "🥜", "פיצוחים, חופן", 170),
    ("s3", "🍔", "המבורגר", 800), ("s4", "🍟", "צ׳יפס", 400),
    ("s5", "🍕", "משולש פיצה", 300), ("s6", "🍷", "כוס יין", 120),
    ("s7", "🍨", "גלידה/קינוח", 300),
]
# המזהים זהים לשמות העמודות הישנות ב-days, כדי שההעתקה תהיה ישירה
DEFAULT_CHECKS = [
    ("strength", "אימון כוח"), ("cardio", "אירובי"),
    ("fish", "דגים"), ("vitamin_d", "ויטמין D"),
]
DEFAULT_SETTINGS = {"protein_target": "130", "sin_budget": "1250", "deficit_daily": "500"}
SETTING_KEYS = tuple(DEFAULT_SETTINGS)

DAY_FIELDS = ("protein_g", "protein_ok", "strength", "cardio", "fish", "vitamin_d", "notes")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _meta(c, key):
    row = c.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def _set_meta(c, key, value):
    c.execute("INSERT INTO meta(key, value) VALUES (?,?) "
              "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def _premigration_backup(version: int):
    """עותק מלא לפני שינוי מבנה. השם לא מתחיל ב-diet- ולכן הסבב הלילי לא מוחק אותו."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%SZ")
    dst = os.path.join(BACKUP_DIR, f"premigration-v{version}-{stamp}.db")
    src, out = sqlite3.connect(DB_PATH), sqlite3.connect(dst)
    try:
        src.backup(out)
    finally:
        out.close()
        src.close()
    print(f"migration: backup saved to {dst}", flush=True)


def init():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    existed = os.path.exists(DB_PATH) and os.path.getsize(DB_PATH) > 0
    with tx() as c:
        c.execute("PRAGMA journal_mode=WAL")
        has_meta = c.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone()
        version = int(_meta(c, "schema_version") or 1) if has_meta else (1 if existed else 0)
    if existed and version < SCHEMA_VERSION:
        _premigration_backup(SCHEMA_VERSION)

    with tx() as c:
        c.executescript(SCHEMA)
        c.executemany("INSERT OR IGNORE INTO weeks(week, date, target_kg) VALUES (?,?,?)",
                      list(plan.week_rows()))
        # ברירות מחדל נזרעות פעם אחת בלבד, כדי שמחיקה של כפתור תישאר מחוקה
        if not _meta(c, "foods_seeded"):
            c.executemany("INSERT OR IGNORE INTO foods(id, name, protein_g, sort) VALUES (?,?,?,?)",
                          [(i, n, g, k) for k, (i, n, g) in enumerate(DEFAULT_FOODS)])
            _set_meta(c, "foods_seeded", 1)
        if not _meta(c, "sins_seeded"):
            c.executemany("INSERT OR IGNORE INTO sin_items(id, emoji, name, kcal, sort) VALUES (?,?,?,?,?)",
                          [(i, e, n, k, s) for s, (i, e, n, k) in enumerate(DEFAULT_SINS)])
            _set_meta(c, "sins_seeded", 1)
        if not _meta(c, "checks_seeded"):
            c.executemany("INSERT OR IGNORE INTO checklist_items(id, label, sort) VALUES (?,?,?)",
                          [(i, l, s) for s, (i, l) in enumerate(DEFAULT_CHECKS)])
            _set_meta(c, "checks_seeded", 1)
        for k, v in DEFAULT_SETTINGS.items():
            c.execute("INSERT OR IGNORE INTO meta(key, value) VALUES (?,?)", (f"setting_{k}", v))

        if int(_meta(c, "schema_version") or 1) < 2:
            _migrate_v2(c)
            _set_meta(c, "schema_version", 2)


def _migrate_v2(c):
    """v1 → v2: סכום חלבון יומי → הזנה אחת; עמודות הצ'ק-ליסט → day_checks."""
    n_entries = c.execute("""
        INSERT OR IGNORE INTO entries(id, date, kind, name, emoji, amount, created_at)
        SELECT 'legacy-' || date, date, 'protein', 'חלבון (סיכום קודם)', '', protein_g, date || 'T00:00:00'
        FROM days
        WHERE protein_g > 0
          AND NOT EXISTS (SELECT 1 FROM entries e WHERE e.date = days.date AND e.kind = 'protein')
    """).rowcount
    n_checks = 0
    for col in ("strength", "cardio", "fish", "vitamin_d"):
        n_checks += c.execute(
            f"INSERT OR IGNORE INTO day_checks(date, item_id) SELECT date, ? FROM days WHERE {col} = 1",
            (col,)).rowcount
    print(f"migration v2: {n_entries} protein entries, {n_checks} checklist marks copied", flush=True)


def get_settings(c) -> dict:
    out = {}
    for k in SETTING_KEYS:
        v = _meta(c, f"setting_{k}") or DEFAULT_SETTINGS[k]
        out[k] = float(v)
    return out


def set_settings(c, values: dict):
    for k, v in values.items():
        if k in SETTING_KEYS:
            _set_meta(c, f"setting_{k}", v)


def sync_protein(c, date: str):
    """שומר את days.protein_g שווה לסכום ההזנות (כדי שגם קוד/ייצוא ישן יראה ערך נכון)."""
    total = c.execute("SELECT COALESCE(SUM(amount), 0) FROM entries WHERE date=? AND kind='protein'",
                      (date,)).fetchone()[0]
    c.execute("INSERT OR IGNORE INTO days(date) VALUES (?)", (date,))
    c.execute("UPDATE days SET protein_g=? WHERE date=?", (int(round(total)), date))
