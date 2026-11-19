"""הערכת חלבון מטקסט חופשי בעזרת Claude (Structured Outputs)."""
import os
import threading
import time

import anthropic
from pydantic import BaseModel

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
# מודלים שתומכים ב-fallback בצד השרת כשהבקשה נדחית
_FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5",
                    "claude-fable-5-1", "claude-fable-5-2"}

SYSTEM = """אתה תזונאי שמעריך כמות חלבון במזון. המשתמש כותב בעברית (לפעמים בקיצור או עם שגיאות) מה אכל.
פרק את הטקסט לפריטים נפרדים, ולכל פריט החזר:
- name: שם קצר בעברית (למשל "חזה עוף")
- amount: הכמות כפי שהבנת אותה (למשל "200 ג׳ מבושל"). אם לא צוינה כמות — הנח מנה סטנדרטית ישראלית וכתוב אותה.
- protein_g: גרמים של חלבון, מספר שלם או עם ספרה אחת אחרי הנקודה.
העדף ערכים של מוצרים נפוצים בישראל (תנובה, שטראוס, יטבתה וכו') כשמוזכר מותג או מוצר מוכר.
note: משפט קצר אחד בעברית רק אם הנחת הנחה משמעותית; אחרת מחרוזת ריקה.
אם הטקסט אינו מתאר אוכל, החזר items ריקה ו-note שמסביר."""


class Item(BaseModel):
    name: str
    amount: str
    protein_g: float


class Estimate(BaseModel):
    items: list[Item]
    note: str


class AIError(Exception):
    pass


def _api_key() -> str:
    # ניקוי טעויות העתקה נפוצות: רווחים, ירידת שורה, מרכאות מסביב
    return os.environ.get("ANTHROPIC_API_KEY", "").strip().strip("'\"").strip()


def enabled() -> bool:
    return bool(_api_key())


_client = None
_lock = threading.Lock()
_calls: list[float] = []
MAX_PER_HOUR = int(os.environ.get("CLAUDE_MAX_PER_HOUR", "60"))


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=_api_key(), timeout=60, max_retries=2)
    return _client


def _check_budget():
    now = time.time()
    with _lock:
        _calls[:] = [t for t in _calls if t > now - 3600]
        if len(_calls) >= MAX_PER_HOUR:
            raise AIError("הגעת למגבלת הבקשות לשעה. נסה שוב מאוחר יותר")
        _calls.append(now)


def estimate(text: str) -> dict:
    if not enabled():
        raise AIError("Claude לא מוגדר (חסר ANTHROPIC_API_KEY)")
    _check_budget()
    kwargs = dict(
        model=MODEL,
        max_tokens=4000,
        system=SYSTEM,
        messages=[{"role": "user", "content": text}],
        output_format=Estimate,
        output_config={"effort": "low"},  # משימה פשוטה — מעט חשיבה, תשובה מהירה וזולה
    )
    if MODEL in _FALLBACK_MODELS:
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    try:
        resp = _get_client().beta.messages.parse(**kwargs)
    except anthropic.AuthenticationError:
        raise AIError("מפתח ה-API של Claude לא תקין")
    except anthropic.RateLimitError:
        raise AIError("Claude עמוס כרגע, נסה שוב בעוד דקה")
    except anthropic.APIStatusError as e:
        raise AIError(f"שגיאה מ-Claude ({e.status_code})")
    except anthropic.APIConnectionError:
        raise AIError("אין חיבור ל-Claude")

    if resp.stop_reason == "refusal":
        raise AIError("Claude סירב לבקשה")
    if resp.stop_reason == "max_tokens" or resp.parsed_output is None:
        raise AIError("התשובה של Claude לא הושלמה, נסה ניסוח קצר יותר")
    out = resp.parsed_output
    items = [{"name": i.name.strip()[:60], "amount": i.amount.strip()[:80],
              "protein_g": max(0.0, min(300.0, round(i.protein_g, 1)))} for i in out.items]
    return {"items": items, "total_g": round(sum(i["protein_g"] for i in items)),
            "note": out.note.strip()[:300]}
