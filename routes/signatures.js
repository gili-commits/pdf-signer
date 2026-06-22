const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const supabase = require('../services/supabase');

// GET /api/signatures — רשימת החתימות השמורות של המשתמש
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('saved_signatures')
      .select('id, name, signature_data, created_at')
      .eq('user_id', req.session.userId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('שגיאה בשליפת חתימות שמורות:', err.message);
    res.status(500).json({ error: 'שגיאה בשליפת החתימות השמורות' });
  }
});

// POST /api/signatures — שמירת חתימה חדשה
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, signature_data } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'יש להזין שם לחתימה' });
    }
    if (!signature_data || !signature_data.startsWith('data:image/png;base64,')) {
      return res.status(400).json({ error: 'נתוני חתימה לא תקינים' });
    }

    const { data, error } = await supabase
      .from('saved_signatures')
      .insert({
        user_id: req.session.userId,
        name: name.trim(),
        signature_data
      })
      .select('id, name, signature_data, created_at')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('שגיאה בשמירת חתימה:', err.message);
    res.status(500).json({ error: 'שגיאה בשמירת החתימה' });
  }
});

// DELETE /api/signatures/:id — מחיקת חתימה שמורה
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('saved_signatures')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId);

    if (error) throw error;
    res.json({ message: 'החתימה נמחקה' });
  } catch (err) {
    console.error('שגיאה במחיקת חתימה:', err.message);
    res.status(500).json({ error: 'שגיאה במחיקת החתימה' });
  }
});

module.exports = router;
