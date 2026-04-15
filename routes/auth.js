const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'יש להזין אימייל וסיסמה' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    return res.status(401).json({ error: 'אימייל או סיסמה שגויים' });
  }

  req.session.userId = data.user.id;
  req.session.email = data.user.email;

  res.json({ message: 'התחברת בהצלחה', email: data.user.email });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'שגיאה בהתנתקות' });
    }
    res.json({ message: 'התנתקת בהצלחה' });
  });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'לא מחובר' });
  }

  res.json({
    userId: req.session.userId,
    email: req.session.email
  });
});

module.exports = router;
