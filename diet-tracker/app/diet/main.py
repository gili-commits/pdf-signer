import asyncio
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import auth, backup, db, plan

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


def _day_row(c, d: str) -> dict:
    row = c.execute("SELECT * FROM days WHERE date=?", (d,)).fetchone()
    if row:
        out = dict(row)
    else:
        out = {"date": d, **{f: 0 for f in db.DAY_FIELDS}, "notes": ""}
    for f in ("protein_ok", "strength", "cardio", "fish", "vitamin_d"):
        out[f] = bool(out[f])
    return out


@api.get("/summary")
def summary():
    with db.tx() as c:
        weights = [dict(r) for r in c.execute("SELECT date, kg FROM weights ORDER BY date")]
        weeks = []
        for r in c.execute("SELECT * FROM weeks ORDER BY week").fetchall():
            lo, hi = plan.week_range(r["week"])
            avg = c.execute(
                "SELECT AVG(kg) a, COUNT(*) n FROM weights WHERE date BETWEEN ? AND ?", (lo, hi)
            ).fetchone()
            weeks.append({**dict(r), "from": lo, "avg_kg": round(avg["a"], 2) if avg["n"] else None,
                          "count": avg["n"]})
        recent = [d["date"] for d in c.execute(
            "SELECT date FROM days ORDER BY date DESC LIMIT 14")]
        days = [_day_row(c, d) for d in recent]
    return {"plan": plan.as_dict(), "weights": weights, "weeks": weeks, "recent_days": days}


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


@api.get("/days/{d}")
def get_day(d: date):
    with db.tx() as c:
        return _day_row(c, d.isoformat())


class DayPatch(BaseModel):
    protein_g: int | None = Field(None, ge=0, le=1000)
    protein_ok: bool | None = None
    strength: bool | None = None
    cardio: bool | None = None
    fish: bool | None = None
    vitamin_d: bool | None = None
    notes: str | None = Field(None, max_length=2000)


@api.patch("/days/{d}")
def patch_day(d: date, body: DayPatch):
    changes = {k: (int(v) if isinstance(v, bool) else v)
               for k, v in body.model_dump(exclude_none=True).items()}
    ds = d.isoformat()
    with db.tx() as c:
        c.execute("INSERT OR IGNORE INTO days(date) VALUES (?)", (ds,))
        if changes:
            # שמות העמודות מגיעים מהמודל בלבד (רשימה סגורה), לא מהמשתמש
            sets = ", ".join(f"{k}=?" for k in changes)
            c.execute(f"UPDATE days SET {sets} WHERE date=?", (*changes.values(), ds))
        return _day_row(c, ds)


class WeekPatch(BaseModel):
    notes: str = Field(max_length=2000)


@api.patch("/weeks/{week}")
def patch_week(week: int, body: WeekPatch):
    with db.tx() as c:
        cur = c.execute("UPDATE weeks SET notes=? WHERE week=?", (body.notes, week))
        if not cur.rowcount:
            raise HTTPException(404, "שבוע לא קיים")
    return {"week": week, "notes": body.notes}


app.include_router(api)
