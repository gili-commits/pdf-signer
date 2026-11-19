import asyncio
import csv
import io
import re
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai, auth, backup, db, plan

STATIC = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app):
    db.init()
    auth.init_password()
    task = asyncio.create_task(backup.nightly_loop())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; connect-src 'self'; manifest-src 'self'; "
    "worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
)


@app.middleware("http")
async def security(request: Request, call_next):
    # הגנת CSRF נוספת מעבר ל-SameSite: בקשות כתיבה חייבות להגיע מאותו origin
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        host = request.headers.get("host")
        if origin and origin.split("://", 1)[-1] != host:
            return JSONResponse({"detail": "מקור לא מורשה"}, status_code=403)
    resp = await call_next(request)
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


def require_auth(request: Request):
    if not auth.session_valid(request.cookies.get(auth.COOKIE_NAME)):
        raise HTTPException(401, "נדרשת התחברות")


def _page(name: str):
    return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})


# ---------- דפים ----------
@app.get("/", include_in_schema=False)
def index(request: Request):
    if not auth.session_valid(request.cookies.get(auth.COOKIE_NAME)):
        return RedirectResponse("/login", status_code=303)
    return _page("index.html")


@app.get("/login", include_in_schema=False)
def login_page():
    if not auth.ENABLED:
        return RedirectResponse("/", status_code=303)
    return _page("login.html")


@app.get("/sw.js", include_in_schema=False)
def sw():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest",
                        media_type="application/manifest+json")


@app.get("/healthz", include_in_schema=False)
def healthz():
    return {"ok": True}


app.mount("/static", StaticFiles(directory=STATIC), name="static")


# ---------- התחברות ----------
class LoginIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


@app.post("/api/login")
async def login(body: LoginIn, request: Request):
    ip = request.client.host if request.client else "?"
    wait = auth.limiter.retry_after(ip)
    if wait:
        return JSONResponse({"detail": f"יותר מדי ניסיונות. נסה שוב בעוד {wait // 60 + 1} דקות"},
                            status_code=429, headers={"Retry-After": str(wait)})
    ok = await asyncio.to_thread(auth.check_password, body.password)
    if not ok:
        auth.limiter.fail(ip)
        await asyncio.sleep(1)
        raise HTTPException(401, "סיסמה שגויה")
    auth.limiter.reset(ip)
    token = await asyncio.to_thread(auth.create_session)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(auth.COOKIE_NAME, token, max_age=auth.SESSION_TTL, httponly=True,
                    samesite="lax", secure=auth.COOKIE_SECURE, path="/")
    return resp


@app.post("/api/logout")
def logout(request: Request):
    auth.delete_session(request.cookies.get(auth.COOKIE_NAME))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.COOKIE_NAME, path="/")
    return resp


# ---------- API (מוגן) ----------
api = APIRouter(prefix="/api", dependencies=[Depends(require_auth)])

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _check_id(i: str):
    if not ID_RE.match(i):
        raise HTTPException(422, "מזהה לא תקין")


def _rows(c, sql, *args):
    return [dict(r) for r in c.execute(sql, args)]


@api.get("/summary")
def summary():
    """כל הנתונים בבקשה אחת (משתמש יחיד, נפח קטן) — הלקוח מחשב מהם הכול, גם אופליין."""
    with db.tx() as c:
        weeks = []
        for r in c.execute("SELECT * FROM weeks ORDER BY week").fetchall():
            lo, _ = plan.week_range(r["week"])
            weeks.append({**dict(r), "from": lo})
        return {
            "auth": auth.ENABLED,
            "ai": ai.enabled(),
            "plan": plan.as_dict(),
            "settings": db.get_settings(c),
            "weights": _rows(c, "SELECT date, kg FROM weights ORDER BY date"),
            "waist": _rows(c, "SELECT date, cm FROM waist ORDER BY date"),
            "entries": _rows(c, "SELECT id, date, kind, name, emoji, amount, created_at "
                                "FROM entries ORDER BY date, created_at"),
            "checks": _rows(c, "SELECT date, item_id FROM day_checks ORDER BY date"),
            "notes": _rows(c, "SELECT date, notes FROM days WHERE notes != '' ORDER BY date"),
            "weeks": weeks,
            "foods": _rows(c, "SELECT id, name, protein_g FROM foods ORDER BY sort, rowid"),
            "sin_items": _rows(c, "SELECT id, emoji, name, kcal FROM sin_items ORDER BY sort, rowid"),
            "checklist_items": _rows(c, "SELECT id, label FROM checklist_items ORDER BY sort, rowid"),
        }


# --- משקל ומותניים ---
class WeightIn(BaseModel):
    kg: float = Field(ge=30, le=250)


@api.put("/weights/{d}")
def put_weight(d: date, body: WeightIn):
    kg = round(body.kg, 1)
    with db.tx() as c:
        c.execute("INSERT INTO weights(date, kg) VALUES (?,?) "
                  "ON CONFLICT(date) DO UPDATE SET kg=excluded.kg", (d.isoformat(), kg))
    return {"date": d.isoformat(), "kg": kg}


@api.delete("/weights/{d}")
def delete_weight(d: date):
    with db.tx() as c:
        c.execute("DELETE FROM weights WHERE date=?", (d.isoformat(),))
    return {"ok": True}


class WaistIn(BaseModel):
    cm: float = Field(ge=40, le=200)


@api.put("/waist/{d}")
def put_waist(d: date, body: WaistIn):
    cm = round(body.cm, 1)
    with db.tx() as c:
        c.execute("INSERT INTO waist(date, cm) VALUES (?,?) "
                  "ON CONFLICT(date) DO UPDATE SET cm=excluded.cm", (d.isoformat(), cm))
    return {"date": d.isoformat(), "cm": cm}


@api.delete("/waist/{d}")
def delete_waist(d: date):
    with db.tx() as c:
        c.execute("DELETE FROM waist WHERE date=?", (d.isoformat(),))
    return {"ok": True}


# --- הזנות (חלבון / חטאים) ---
class EntryIn(BaseModel):
    date: date
    kind: str = Field(pattern="^(protein|sin)$")
    name: str = Field(min_length=1, max_length=80)
    emoji: str = Field("", max_length=16)
    amount: float = Field(ge=0, le=5000)
    created_at: datetime


@api.put("/entries/{entry_id}")
def put_entry(entry_id: str, body: EntryIn):
    _check_id(entry_id)
    ds = body.date.isoformat()
    with db.tx() as c:
        old = c.execute("SELECT date FROM entries WHERE id=?", (entry_id,)).fetchone()
        c.execute("""INSERT INTO entries(id, date, kind, name, emoji, amount, created_at)
                     VALUES (?,?,?,?,?,?,?)
                     ON CONFLICT(id) DO UPDATE SET date=excluded.date, kind=excluded.kind,
                       name=excluded.name, emoji=excluded.emoji, amount=excluded.amount""",
                  (entry_id, ds, body.kind, body.name.strip(), body.emoji.strip(),
                   round(body.amount, 1), body.created_at.isoformat()))
        db.sync_protein(c, ds)
        if old and old["date"] != ds:
            db.sync_protein(c, old["date"])
    return {"ok": True}


@api.delete("/entries/{entry_id}")
def delete_entry(entry_id: str):
    with db.tx() as c:
        old = c.execute("SELECT date FROM entries WHERE id=?", (entry_id,)).fetchone()
        c.execute("DELETE FROM entries WHERE id=?", (entry_id,))
        if old:
            db.sync_protein(c, old["date"])
    return {"ok": True}


# --- צ'ק-ליסט והערות ---
class CheckIn(BaseModel):
    done: bool


@api.put("/checks/{d}/{item_id}")
def put_check(d: date, item_id: str, body: CheckIn):
    _check_id(item_id)
    with db.tx() as c:
        if body.done:
            c.execute("INSERT OR IGNORE INTO day_checks(date, item_id) VALUES (?,?)",
                      (d.isoformat(), item_id))
        else:
            c.execute("DELETE FROM day_checks WHERE date=? AND item_id=?", (d.isoformat(), item_id))
    return {"ok": True}


class DayPatch(BaseModel):
    notes: str | None = Field(None, max_length=2000)


@api.patch("/days/{d}")
def patch_day(d: date, body: DayPatch):
    ds = d.isoformat()
    with db.tx() as c:
        c.execute("INSERT OR IGNORE INTO days(date) VALUES (?)", (ds,))
        if body.notes is not None:
            c.execute("UPDATE days SET notes=? WHERE date=?", (body.notes, ds))
    return {"ok": True}


class WeekPatch(BaseModel):
    notes: str = Field(max_length=2000)


@api.patch("/weeks/{week}")
def patch_week(week: int, body: WeekPatch):
    with db.tx() as c:
        cur = c.execute("UPDATE weeks SET notes=? WHERE week=?", (body.notes, week))
        if not cur.rowcount:
            raise HTTPException(404, "שבוע לא קיים")
    return {"week": week, "notes": body.notes}


# --- הגדרות: כפתורים, צ'ק-ליסט, יעדים ---
def _upsert(c, table, item_id, cols: dict):
    nxt = c.execute(f"SELECT COALESCE(MAX(sort), 0) + 1 FROM {table}").fetchone()[0]
    names = ", ".join(cols)
    marks = ", ".join("?" for _ in cols)
    updates = ", ".join(f"{k}=excluded.{k}" for k in cols)
    c.execute(f"INSERT INTO {table}(id, {names}, sort) VALUES (?, {marks}, ?) "
              f"ON CONFLICT(id) DO UPDATE SET {updates}", (item_id, *cols.values(), nxt))


class FoodIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    protein_g: float = Field(ge=0, le=300)


@api.put("/foods/{item_id}")
def put_food(item_id: str, body: FoodIn):
    _check_id(item_id)
    with db.tx() as c:
        _upsert(c, "foods", item_id, {"name": body.name.strip(), "protein_g": round(body.protein_g, 1)})
    return {"ok": True}


@api.delete("/foods/{item_id}")
def delete_food(item_id: str):
    with db.tx() as c:
        c.execute("DELETE FROM foods WHERE id=?", (item_id,))
    return {"ok": True}


class SinItemIn(BaseModel):
    emoji: str = Field("", max_length=16)
    name: str = Field(min_length=1, max_length=60)
    kcal: float = Field(ge=0, le=5000)


@api.put("/sin-items/{item_id}")
def put_sin_item(item_id: str, body: SinItemIn):
    _check_id(item_id)
    with db.tx() as c:
        _upsert(c, "sin_items", item_id,
                {"emoji": body.emoji.strip(), "name": body.name.strip(), "kcal": round(body.kcal)})
    return {"ok": True}


@api.delete("/sin-items/{item_id}")
def delete_sin_item(item_id: str):
    with db.tx() as c:
        c.execute("DELETE FROM sin_items WHERE id=?", (item_id,))
    return {"ok": True}


class CheckItemIn(BaseModel):
    label: str = Field(min_length=1, max_length=60)


@api.put("/checklist-items/{item_id}")
def put_check_item(item_id: str, body: CheckItemIn):
    _check_id(item_id)
    with db.tx() as c:
        _upsert(c, "checklist_items", item_id, {"label": body.label.strip()})
    return {"ok": True}


@api.delete("/checklist-items/{item_id}")
def delete_check_item(item_id: str):
    # הסימונים ההיסטוריים ב-day_checks נשמרים; אם הפריט יוחזר עם אותו מזהה הם יחזרו
    with db.tx() as c:
        c.execute("DELETE FROM checklist_items WHERE id=?", (item_id,))
    return {"ok": True}


class SettingsIn(BaseModel):
    protein_target: float | None = Field(None, ge=10, le=400)
    sin_budget: float | None = Field(None, ge=0, le=20000)
    deficit_daily: float | None = Field(None, ge=50, le=3000)


@api.put("/settings")
def put_settings(body: SettingsIn):
    with db.tx() as c:
        db.set_settings(c, body.model_dump(exclude_none=True))
        return db.get_settings(c)


# --- ייצוא ---
@api.get("/export.csv")
def export_csv():
    with db.tx() as c:
        items = _rows(c, "SELECT id, label FROM checklist_items ORDER BY sort, rowid")
        known = {i["id"] for i in items}
        # גם פריטי צ'ק-ליסט שנמחקו מההגדרות אבל יש להם סימונים — שלא ילכו לאיבוד בייצוא
        for r in c.execute("SELECT DISTINCT item_id FROM day_checks"):
            if r["item_id"] not in known:
                items.append({"id": r["item_id"], "label": r["item_id"]})
        dates = sorted({r[0] for r in c.execute(
            "SELECT date FROM weights UNION SELECT date FROM waist UNION SELECT date FROM entries "
            "UNION SELECT date FROM day_checks UNION SELECT date FROM days WHERE notes != ''")})
        weights = {r["date"]: r["kg"] for r in c.execute("SELECT * FROM weights")}
        waist = {r["date"]: r["cm"] for r in c.execute("SELECT * FROM waist")}
        notes = {r["date"]: r["notes"] for r in c.execute("SELECT date, notes FROM days")}
        checks = {(r["date"], r["item_id"]) for r in c.execute("SELECT * FROM day_checks")}
        entries = _rows(c, "SELECT * FROM entries ORDER BY date, created_at")
        target = db.get_settings(c)["protein_target"]

    per_day = {}
    for e in entries:
        d = per_day.setdefault(e["date"], {"p": 0.0, "pl": [], "s": 0.0, "sl": []})
        label = f'{e["emoji"]} {e["name"]}'.strip()
        if e["kind"] == "protein":
            d["p"] += e["amount"]
            d["pl"].append(f'{label} ({e["amount"]:g})')
        else:
            d["s"] += e["amount"]
            d["sl"].append(f'{label} ({e["amount"]:g})')

    buf = io.StringIO()
    buf.write("﻿")  # BOM כדי ש-Excel יציג עברית נכון
    w = csv.writer(buf)
    w.writerow(["תאריך", "משקל (ק״ג)", "מותניים (ס״מ)", "חלבון (ג׳)", "ביעד החלבון",
                "פירוט חלבון", "חטאים (קל׳)", "פירוט חטאים",
                *[i["label"] for i in items], "הערות"])
    for ds in dates:
        d = per_day.get(ds, {"p": 0, "pl": [], "s": 0, "sl": []})
        w.writerow([ds, weights.get(ds, ""), waist.get(ds, ""), round(d["p"]) or "",
                    "כן" if d["p"] >= target else "", " | ".join(d["pl"]),
                    round(d["s"]) or "", " | ".join(d["sl"]),
                    *["כן" if (ds, i["id"]) in checks else "" for i in items],
                    notes.get(ds, "")])
    fname = f"diet-tracker-{date.today().isoformat()}.csv"
    return Response(buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{fname}"'})


# --- Claude ---
class EstimateIn(BaseModel):
    text: str = Field(min_length=2, max_length=500)


@api.post("/protein/estimate")
def protein_estimate(body: EstimateIn):
    try:
        return ai.estimate(body.text.strip())
    except ai.AIError as e:
        raise HTTPException(502, str(e))


app.include_router(api)
