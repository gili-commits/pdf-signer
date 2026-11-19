"""סיסמה יחידה (bcrypt), סשנים בצד השרת, rate limit בסיסי להתחברות."""
import hashlib
import os
import secrets
import threading
import time
from collections import defaultdict, deque

import bcrypt

from . import db

COOKIE_NAME = "dt_session"
SESSION_TTL = 30 * 24 * 3600
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "true").lower() == "true"

_pw_hash: bytes | None = None


def init_password():
    """APP_PASSWORD_HASH (bcrypt) עדיף; אחרת APP_PASSWORD מגובב בעלייה ונמחק מהסביבה."""
    global _pw_hash
    raw = os.environ.pop("APP_PASSWORD", "")
    pre = os.environ.get("APP_PASSWORD_HASH", "").strip()
    if pre:
        _pw_hash = pre.encode()
    elif raw:
        _pw_hash = bcrypt.hashpw(raw.encode()[:72], bcrypt.gensalt(12))
    else:
        raise RuntimeError("חסר APP_PASSWORD או APP_PASSWORD_HASH")


def check_password(pw: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode()[:72], _pw_hash)
    except ValueError:
        return False


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session() -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with db.tx() as c:
        c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
        c.execute("INSERT INTO sessions VALUES (?,?)", (_h(token), now + SESSION_TTL))
    return token


def session_valid(token: str | None) -> bool:
    if not token:
        return False
    with db.tx() as c:
        row = c.execute(
            "SELECT expires_at FROM sessions WHERE token_hash=?", (_h(token),)
        ).fetchone()
    return bool(row) and row["expires_at"] > time.time()


def delete_session(token: str | None):
    if token:
        with db.tx() as c:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (_h(token),))


class RateLimiter:
    """עד 5 כישלונות ל-IP ו-20 בסך הכול בחלון של 15 דקות."""

    WINDOW = 15 * 60
    PER_IP = 5
    GLOBAL = 20

    def __init__(self):
        self._lock = threading.Lock()
        self._ip = defaultdict(deque)
        self._all = deque()

    def _trim(self, q, now):
        while q and q[0] < now - self.WINDOW:
            q.popleft()

    def retry_after(self, ip: str) -> int:
        now = time.time()
        with self._lock:
            q = self._ip[ip]
            self._trim(q, now)
            self._trim(self._all, now)
            if len(q) >= self.PER_IP:
                return int(q[0] + self.WINDOW - now) + 1
            if len(self._all) >= self.GLOBAL:
                return int(self._all[0] + self.WINDOW - now) + 1
        return 0

    def fail(self, ip: str):
        now = time.time()
        with self._lock:
            self._ip[ip].append(now)
            self._all.append(now)

    def reset(self, ip: str):
        with self._lock:
            self._ip.pop(ip, None)


limiter = RateLimiter()
