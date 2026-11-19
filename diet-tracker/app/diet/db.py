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
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  expires_at INT  NOT NULL
);
"""

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
