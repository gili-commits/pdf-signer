import os
import sqlite3
from contextlib import contextmanager

from . import plan

DB_PATH = os.environ.get("DB_PATH", "/data/diet.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS weights(
  date TEXT PRIMARY KEY,
  kg   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS days(
  date       TEXT PRIMARY KEY,
  protein_g  INT  NOT NULL DEFAULT 0,
  protein_ok INT  NOT NULL DEFAULT 0,
  strength   INT  NOT NULL DEFAULT 0,
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
"""

DEFAULT_FOODS = [
    ("d1", "עוף 180 ג׳", 55), ("d2", "טונה", 25), ("d3", "2 ביצים", 13),
    ("d4", "קוטג׳ 100 ג׳", 11), ("d5", "מעדן חלבון", 20), ("d6", "סקייר 200 ג׳", 20),
]

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


def init():
    os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
    with tx() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript(SCHEMA)
        c.executemany(
            "INSERT OR IGNORE INTO weeks(week, date, target_kg) VALUES (?,?,?)",
            list(plan.week_rows()),
        )
        # כפתורי ברירת המחדל נזרעים פעם אחת בלבד, כדי שמחיקה שלהם תישאר
        if not c.execute("SELECT 1 FROM meta WHERE key='foods_seeded'").fetchone():
            c.executemany("INSERT OR IGNORE INTO foods(id, name, protein_g, sort) VALUES (?,?,?,?)",
                          [(i, n, g, k) for k, (i, n, g) in enumerate(DEFAULT_FOODS)])
            c.execute("INSERT INTO meta VALUES ('foods_seeded', '1')")
