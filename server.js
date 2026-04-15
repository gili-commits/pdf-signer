require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy — נדרש עבור Render/ngrok כדי ש-secure cookies יעבדו
const isProduction = process.env.NODE_ENV === 'production' || process.env.BASE_URL?.startsWith('https');
if (isProduction) {
  app.set('trust proxy', 1);
}

// Middleware — גוף בקשה
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// קבצים סטטיים
app.use(express.static(path.join(__dirname, 'public')));

// PDF.js — הגשת קבצי build, cmaps ו-standard_fonts מ-node_modules
app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist'), {
  maxAge: '7d'
}));

// Session
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 1000 * 60 * 60 * 24 // 24 שעות
  }
}));

// Routes — API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/editor', require('./routes/editor'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/sign', require('./routes/sign'));

// דף חתימה ציבורי — מגיש את sign.html לכל token
app.get('/sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

// דף עורך — מגיש את editor.html
app.get('/editor', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

// טיפול בשגיאות כלליות
app.use((err, req, res, next) => {
  console.error('שגיאת שרת:', err.message);
  res.status(500).json({ error: 'שגיאה פנימית בשרת' });
});

app.listen(PORT, () => {
  console.log(`השרת רץ על פורט ${PORT}`);
});
