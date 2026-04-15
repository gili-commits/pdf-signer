# PDF Signer — CLAUDE.md

## תיאור הפרויקט
אפליקציית חתימה דיגיטלית על PDF. המשתמש המחובר מעלה PDF, מציב שדות חתימה, ושולח קישור ייחודי ללקוח. הלקוח פותח קישור, חותם, ומוריד. ללא צורך ב-login מצד הלקוח.

## Stack
- Backend: Node.js + Express
- Frontend: HTML סטטי (ללא framework) + PDF.js + Fabric.js
- DB + Auth: Supabase (PostgreSQL + Auth)
- אחסון קבצים: Supabase Storage (bucket: `pdfs`)
- עריכת PDF: pdf-lib
- מיילים: Nodemailer + Gmail SMTP
- Hosting: Render

## פקודת הרצה
```bash
nvm use 20
npm run dev
```

## משתני סביבה (.env)
```
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SESSION_SECRET=
GMAIL_USER=
GMAIL_PASS=
BASE_URL=http://localhost:3000
```

## מבנה קבצים
```
pdf-signer/
├── server.js              # נקודת כניסה
├── .env
├── package.json
├── CLAUDE.md
├── routes/
│   ├── auth.js            # login/logout
│   ├── documents.js       # העלאה, רשימה, מחיקה
│   ├── editor.js          # שמירת שדות חתימה
│   ├── requests.js        # שליחת בקשות חתימה
│   └── sign.js            # מסלול ציבורי לחתימת לקוח
├── middleware/
│   └── auth.js            # בדיקת session
├── services/
│   ├── supabase.js        # client מוכן
│   ├── storage.js         # העלאה/הורדה מ-Supabase Storage
│   ├── pdfService.js      # שילוב חתימה ב-PDF עם pdf-lib
│   └── mailer.js          # שליחת מיילים
└── public/
    ├── index.html         # דשבורד
    ├── editor.html        # עורך PDF
    ├── sign.html          # דף חתימת לקוח (ציבורי)
    └── js/
        ├── editor.js      # לוגיקת עורך (PDF.js + Fabric.js)
        └── sign.js        # לוגיקת חתימת לקוח
```

## סכמת DB (Supabase)

### טבלת documents
```sql
create table documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  filename text not null,
  storage_path text not null,
  status text default 'draft', -- draft | sent | completed
  created_at timestamptz default now()
);
```

### טבלת signature_fields
```sql
create table signature_fields (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  page int not null,
  x float not null,
  y float not null,
  width float not null,
  height float not null,
  field_type text default 'signature', -- signature | text | date
  created_at timestamptz default now()
);
```

### טבלת signature_requests
```sql
create table signature_requests (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  recipient_email text not null,
  recipient_name text not null,
  token text unique not null default gen_random_uuid()::text,
  status text default 'pending', -- pending | signed
  signed_at timestamptz,
  created_at timestamptz default now()
);
```

### טבלת signatures
```sql
create table signatures (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references signature_requests(id),
  field_id uuid references signature_fields(id),
  signature_data text not null, -- base64 PNG
  signed_at timestamptz default now()
);
```

## זרימת עבודה

### 1. העלאת מסמך
POST /api/documents/upload
- מקבל קובץ PDF (multipart)
- מעלה ל-Supabase Storage תחת: pdfs/{user_id}/{uuid}.pdf
- שומר רשומה ב-documents
- מחזיר document_id → redirect ל-/editor.html?doc={id}

### 2. עורך (editor.html)
- PDF.js מציג את הקובץ
- Fabric.js שכבה שקופה מעל — המשתמש מציב שדות
- כל שדה נשמר בזמן אמת → POST /api/editor/:docId/fields
- כפתור "שלח לחתימה" → פותח modal עם אימייל ושם

### 3. שליחת בקשה
POST /api/requests/:docId/send
- מייצר token ייחודי (UUID)
- שומר ב-signature_requests
- שולח מייל ללקוח עם קישור: {BASE_URL}/sign/{token}
- מעדכן document.status → 'sent'

### 4. דף חתימה (sign.html) — ציבורי
GET /sign/:token
- בודק תקינות token
- מציג PDF + שדה חתימה מודגש
- הלקוח חותם (canvas ציור)
- POST /api/sign/:token/submit → מעלה חתימה

### 5. שילוב חתימה ב-PDF
pdfService.js:
- מוריד PDF מקורי מ-Storage
- pdf-lib מוסיף את תמונת החתימה (base64 PNG) בקואורדינטות השדה
- מעלה PDF_חתום.pdf חזרה ל-Storage
- מעדכן סטטוס → 'signed'
- שולח מייל לבעל המסמך: "הלקוח חתם, הנה הקישור להורדה"

## חוקי עבודה
- כל התגיות, שמות השדות, הודעות השגיאה — בעברית
- RTL בכל ה-HTML (dir="rtl")
- לא להשתמש ב-TypeScript
- לא להשתמש ב-React/Vue — HTML + Vanilla JS בלבד
- שמות קבצים ומשתנים — באנגלית
- session-based auth (express-session + Supabase Auth)
- לא לאחסן קבצי PDF בשרת — רק ב-Supabase Storage

## חבילות npm
```json
{
  "dependencies": {
    "@supabase/supabase-js": "^2",
    "express": "^4",
    "express-session": "^1",
    "multer": "^1",
    "pdf-lib": "^1",
    "nodemailer": "^6",
    "dotenv": "^16",
    "uuid": "^9"
  },
  "devDependencies": {
    "nodemon": "^3"
  }
}
```

## CDN בצד לקוח (בלי npm)
```html
<!-- PDF.js -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<!-- Fabric.js -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js"></script>
```

## הערות חשובות
- Supabase Storage bucket בשם `pdfs` חייב להיות private
- signed URLs להורדה — תקפים ל-60 דקות בלבד
- token של חתימה — חד-פעמי, מתבטל אחרי שימוש
- הוסף RLS ל-documents: user_id = auth.uid()
- signature_requests ו-signatures — נגישות דרך service_key בלבד (backend)
