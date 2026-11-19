# RUNBOOK — מעקב משקל ותזונה

אפליקציית PWA למשתמש יחיד. שני קונטיינרים בפרויקט compose אחד (`diet-tracker`):

| שירות | קונטיינר | תפקיד |
|---|---|---|
| `app` | `diet-tracker-app` | FastAPI על `0.0.0.0:8080` **בתוך** הרשת `diet-tracker-backend` בלבד |
| `tailscale` | `diet-tracker-tailscale` | node עצמאי `diet-tracker` ב-userspace, `tailscale serve` → HTTPS → `http://app:8080` |

**בידוד:** אין `ports:` בכלל, כלומר שום פורט לא נפתח על ה-host ואין צורך לגעת ב-ufw.
הרשת `diet-tracker-backend` היא `internal`, וה-app מקבל ממנה תעבורה רק מקונטיינר ה-tailscale. יציאה לאינטרנט, לצורך Claude API בלבד, עוברת דרך `diet-tracker-egress`.
ה-volumes `diet-tracker-data` ו-`diet-tracker-ts-state` שייכים רק לפרויקט הזה.
ה-node של Tailscale נפרד משאר ה-nodes בשרת: יש לו state משלו, הוא לא משתמש ב-`/dev/net/tun` ולא דורש `NET_ADMIN`.

---

## 1. הכנה חד-פעמית ב-Tailscale

1. ב-[admin console](https://login.tailscale.com/admin/dns): **DNS** → לוודא ש-**MagicDNS** מופעל,
   ובאותו מסך → **HTTPS Certificates** → **Enable HTTPS**.
2. הפקת auth key: **Settings → Keys → Generate auth key**
   - Reusable: **כבוי** · Ephemeral: **כבוי** (צריך node קבוע)
   - Pre-approved: **פועל** (אם מופעל אישור מכשירים ב-tailnet)
   - Tags: אופציונלי (ראה סעיף 9)
   - להעתיק את המפתח (`tskey-auth-...`). הוא מוצג פעם אחת בלבד.
3. אחרי ההרמה הראשונה (סעיף 3): **Machines** → `diet-tracker` → **⋯ → Disable key expiry**,
   כדי שה-node לא יתנתק אחרי 180 יום.

## 2. התקנה על השרת

```bash
mkdir -p ~/apps && cd ~/apps
# מתוך הריפו הזה (התיקייה diet-tracker היא עצמאית):
cp -r /path/to/pdf-signer/diet-tracker ./diet-tracker
cd diet-tracker
git init && git add -A && git commit -m "diet-tracker: initial"   # ריפו נפרד

cp .env.example .env
chmod 600 .env
nano .env        # למלא TS_AUTHKEY; APP_PASSWORD — אופציונלי
```

> **בלי סיסמה:** אם `APP_PASSWORD` ו-`APP_PASSWORD_HASH` ריקים, אין דף התחברות בכלל.
> כל מכשיר ב-tailnet שלך יכול לפתוח את האפליקציה. למשתמש יחיד שה-tailnet שייך רק לו זה מספיק.
> אם בעתיד תשתף את ה-tailnet עם מישהו, הוסף סיסמה (או ACL — סעיף 9).

### (מומלץ) hash במקום סיסמה בטקסט גלוי
```bash
docker compose build app
docker compose run --rm --no-deps app python -c \
  "import bcrypt,getpass;print(bcrypt.hashpw(getpass.getpass('סיסמה: ').encode()[:72],bcrypt.gensalt(12)).decode())"
```
להדביק ב-`.env` **במרכאות בודדות**: `APP_PASSWORD_HASH='$2b$12$....'` ולרוקן את `APP_PASSWORD=`.

## 3. בנייה והרצה

```bash
cd ~/apps/diet-tracker
docker compose up -d --build
docker compose ps                         # app צריך להיות healthy
docker compose logs -f tailscale          # לחכות לשורה על serve / Startup complete
```

לבדוק שה-node עלה ולמצוא את הכתובת המלאה:
```bash
docker exec diet-tracker-tailscale tailscale status
docker exec diet-tracker-tailscale tailscale serve status
```
הכתובת: `https://diet-tracker.<tailnet>.ts.net`. הבקשה הראשונה עשויה לקחת כמה שניות, בזמן שהתעודה מונפקת.

לבדוק שאין פורט פתוח על ה-host:
```bash
docker ps --filter name=diet-tracker --format '{{.Names}}\t{{.Ports}}'   # עמודת Ports צריכה להיות ריקה (רק 8080/tcp פנימי)
```

אחרי ההרשמה הראשונה (`TS_AUTH_ONCE=true`) המפתח כבר לא נדרש, ואפשר למחוק את `TS_AUTHKEY` מ-`.env`.

## 4. גישה מהטלפון (Android)

1. להתקין את אפליקציית **Tailscale** מ-Google Play ולהתחבר לאותו tailnet.
2. ב-Chrome לפתוח `https://diet-tracker.<tailnet>.ts.net`.
3. להתחבר עם הסיסמה.
4. בתפריט ⋮ ללחוץ **התקנת אפליקציה** (או **הוספה למסך הבית**).

האפליקציה נפתחת במסך מלא. בלי חיבור היא מציגה את הנתונים האחרונים ששמרה, ומה שמזינים בזמן הזה נשמר בתור ונשלח לשרת כשהחיבור חוזר.
ה-Tailscale בטלפון צריך להיות פעיל כדי לסנכרן.

## 5. עדכון גרסה

```bash
cd ~/apps/diet-tracker
git pull                                   # או להעתיק קבצים חדשים
docker compose up -d --build app
docker compose pull tailscale && docker compose up -d tailscale   # עדכון Tailscale
docker image prune -f
```
> בכל שינוי בקבצים תחת `app/static/` יש להעלות את `VERSION` ב-`app/static/sw.js`, כדי שהטלפון יקבל את המעטפת החדשה.

## 6. גיבוי

- **אוטומטי:** כל לילה, אחרי 01:00 UTC (בערך 03:00 בישראל), האפליקציה מגבה את ה-DB עם ה-Online Backup API של SQLite (אותו מנגנון שמאחורי `.backup`).
  הגיבוי נשמר ל-`/data/backups/diet-YYYYMMDD-HHMMSSZ.db` ונשמרים 14 הגיבויים האחרונים.
- **ידני / רשימה:**
```bash
docker compose exec app python -m diet.backup           # גיבוי עכשיו
docker compose exec app python -m diet.backup --list    # רשימת גיבויים
```
- **העתקה אל מחוץ לשרת** (מומלץ מדי פעם):
```bash
docker cp diet-tracker-app:/data/backups ./backups-$(date +%F)
```

## 7. שחזור

```bash
cd ~/apps/diet-tracker
docker compose exec app python -m diet.backup --list
docker compose stop app
docker compose run --rm --no-deps app python -m diet.backup --restore diet-20261201-010012Z.db
docker compose start app
```
השחזור בודק את תקינות קובץ הגיבוי לפני שהוא כותב.
לשחזר מקובץ שנמצא על ה-host, קודם מעתיקים אותו פנימה:
`docker cp ./file.db diet-tracker-app:/data/backups/` (כשהקונטיינר רץ), ואז מבצעים את הצעדים למעלה.

## 8. תפעול שוטף

```bash
docker compose logs --tail=100 app
docker compose restart app
docker compose down            # עוצר. ה-volumes והנתונים נשמרים
# ⚠️ docker compose down -v   מוחק גם את הנתונים ואת זהות ה-node. לא להריץ בלי גיבוי!
```
- **החלפת סיסמה:** לעדכן את `.env` ולהריץ `docker compose up -d app`. סשנים קיימים נשארים בתוקף עד 30 יום.
  כדי לנתק את כולם: `docker compose exec app python -c "from diet import db; c=db.connect(); c.execute('DELETE FROM sessions'); c.commit()"`
- **נעילה אחרי ניסיונות כושלים:** 5 כישלונות מאותו IP (או 20 בסך הכול) חוסמים ל-15 דקות. `docker compose restart app` משחרר את החסימה.

## 9. הקשחה אופציונלית ב-Tailscale ACL

כדי שרק המכשירים שלך יגיעו ל-node:
1. ב-`.env`: `TS_EXTRA_ARGS=--advertise-tags=tag:diet-tracker`, וליצור את ה-auth key עם אותו tag.
2. במדיניות ה-tailnet:
```jsonc
"tagOwners": { "tag:diet-tracker": ["autogroup:admin"] },
"grants": [
  { "src": ["autogroup:member"], "dst": ["tag:diet-tracker"], "ip": ["tcp:443"] }
]
```
(להתאים לכללים שכבר קיימים. אם ה-tailnet עדיין מאפשר הכול כברירת מחדל, אין צורך.)

**לא** מפעילים `tailscale funnel`. ב-`tailscale/serve.json` מוגדר במפורש `AllowFunnel: false`.

## 10. חיבור ל-Claude (הערכת חלבון מטקסט חופשי)

במסך "היום" מופיעה תיבה "מה אכלת?". כותבים בחופשיות, למשל "150 ג׳ חזה עוף, 2 ביצים ויוגורט פרו".
Claude מפרק את הטקסט לפריטים ומעריך את כמות החלבון בכל אחד. אחר כך אפשר:
- להוסיף פריט בודד (+) או את הכול,
- לשמור פריט ככפתור מהיר (☆).

את הכפתורים המהירים אפשר לערוך: "עריכה" מאפשר למחוק כפתור או להוסיף כפתור ידני.

הפעלה:
1. ליצור מפתח ב-https://platform.claude.com/settings/keys (צריך אמצעי תשלום בחשבון ה-API).
2. ב-`.env` להוסיף:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. `docker compose up -d --build app`

הערות:
- **מודל:** ברירת המחדל היא `claude-opus-5-5`. למשימה פשוטה כזו `CLAUDE_MODEL=claude-haiku-5-5` זול בהרבה ובדרך כלל מספיק.
- **הגבלת שימוש:** `CLAUDE_MAX_PER_HOUR` (ברירת מחדל 60) מגביל את מספר הבקשות לשעה, כדי שלא יהיו הפתעות בחשבון.
- **רשת:** כדי לגשת ל-API, קונטיינר ה-app מחובר גם לרשת `diet-tracker-egress`, אבל ליציאה בלבד: אין פורט פתוח פנימה, והגישה לאפליקציה עדיין רק דרך Tailscale.
- **פרטיות:** בהערכת חלבון נשלח ל-Claude רק הטקסט שהקלדת בתיבה.

### יועץ ארוחות 💬
כרטיס "יועץ" במסך "היום". שואלים שאלה חופשית, למשל "אכלתי שווארמה בצהריים, כדאי לי פיצה בערב?".
- **ההקשר שנשלח:** השרת מצרף לשאלה תמונת מצב מה-DB:
  - מה נרשם היום ואתמול, עם שעות
  - כמה חלבון חסר ליעד
  - כמה נשאר בתקציב החטאים השבועי
  - שקילה אחרונה וממוצע 7 ימים מול קו התוכנית
  - הצ׳ק-ליסט של היום
- **ההנחיות ליועץ:** תשובות קצרות ומעשיות, בטון קליל ותומך, בלי המלצות קיצוניות.
- **כפתורי "רשום":** מתחת לתשובה מופיעים פריטים שאפשר לרשום בלחיצה לחלבון או לחטאים.
- **שמירת השיחה:** כל יום שומר שיחה משלו בשרת (טבלה `advisor_messages`), כך שאפשר להמשיך לשאול בהמשך היום. "שיחה חדשה" מוחק את השיחה של אותו יום.
- **פרטיות:** בכל שאלה ליועץ נשלחים ל-Anthropic הנתונים שבתמונת המצב: אוכל, משקל, יעדים והצ׳ק-ליסט של היום ואתמול. לא נשלחים נתונים מימים מוקדמים יותר, חוץ ממשקלי 14 הימים האחרונים שמהם מחושב הממוצע.
- **מודל ומגבלות:** אותו `CLAUDE_MODEL` ואותה מגבלת `CLAUDE_MAX_PER_HOUR` כמו בהערכת החלבון. דורש חיבור לאינטרנט, ולא עובד אופליין.

## 11. מבנה ונתונים

```
diet-tracker/
├── docker-compose.yml       # name: diet-tracker, 2 שירותים, networks/volumes ייעודיים
├── .env.example
├── tailscale/serve.json     # HTTPS :443 → http://app:8080
└── app/
    ├── Dockerfile
    ├── requirements.txt     # fastapi, uvicorn, bcrypt
    ├── make_icons.py        # יוצר את האייקונים בזמן docker build (stdlib בלבד)
    ├── diet/                # main.py (API), db.py, auth.py, plan.py, backup.py, ai.py (Claude)
    └── static/              # index.html, login.html, app.js, style.css, sw.js, manifest, icons
```

טבלאות SQLite (`/data/diet.db`):

| טבלה | מה יש בה |
|---|---|
| `weights`, `waist` | משקל והיקף מותניים לפי תאריך |
| `entries` | כל הזנה בנפרד: חלבון (גרם) או חטא (קלוריות), עם שעה |
| `days` | הערות ליום. `protein_g` נשמר מסונכרן עם סכום ההזנות, לתאימות לאחור |
| `day_checks`, `checklist_items` | סימוני הצ׳ק-ליסט ורשימת הפריטים |
| `foods`, `sin_items` | הכפתורים המהירים |
| `weeks` | 17 שורות היעד |
| `meta` | הגדרות (יעד חלבון, תקציב חטאים, גירעון יומי) וגרסת המבנה |
| `advisor_messages` | שיחות היועץ, לפי יום |
| `sessions` | התחברויות |

הדפדפן שומר רק את תור הכתיבות אופליין והעדפות תצוגה. כל הנתונים נמצאים בשרת.

**שדרוג מבנה (v1 → v2):** רץ אוטומטית בעלייה, פעם אחת בלבד.
- לפני השדרוג נשמר עותק מלא בשם `/data/backups/premigration-v2-*.db`. הסבב הלילי לא מוחק אותו.
- שום טבלה או עמודה קיימת לא נמחקת.
- סכום החלבון היומי הקודם הופך להזנה בשם "חלבון (סיכום קודם)".
- סימוני כוח, אירובי, דגים וויטמין D מועתקים ל-`day_checks`.

**ייצוא:** הגדרות ← "ייצוא ל-CSV", או `GET /api/export.csv`. מתקבלת שורה לכל יום עם משקל, מותניים, חלבון, חטאים, צ׳ק-ליסט והערות.

שבוע *n* מסתיים ב-18.11.2026 + 7n ימים (שבוע 17 מסתיים ב-17.3.2027). היעד הוא ערך הקו הליניארי בתאריך הזה, והממוצע מחושב על 7 הימים שמסתיימים בו.
