const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const supabase = require('../services/supabase');

// פונקציית עזר — בדיקת בעלות על מסמך
async function verifyOwnership(docId, userId) {
  const { data, error } = await supabase
    .from('documents')
    .select('id')
    .eq('id', docId)
    .eq('user_id', userId)
    .single();

  return !error && data;
}

// GET /api/editor/:docId/fields
router.get('/:docId/fields', requireAuth, async (req, res) => {
  try {
    if (!(await verifyOwnership(req.params.docId, req.session.userId))) {
      return res.status(403).json({ error: 'אין הרשאה למסמך זה' });
    }

    const { data, error } = await supabase
      .from('signature_fields')
      .select('*')
      .eq('document_id', req.params.docId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('שגיאה בשליפת שדות:', err.message);
    res.status(500).json({ error: 'שגיאה בשליפת שדות החתימה' });
  }
});

// POST /api/editor/:docId/fields
router.post('/:docId/fields', requireAuth, async (req, res) => {
  try {
    if (!(await verifyOwnership(req.params.docId, req.session.userId))) {
      return res.status(403).json({ error: 'אין הרשאה למסמך זה' });
    }

    const { page, x, y, width, height, field_type } = req.body;

    if (!page || x == null || y == null || !width || !height) {
      return res.status(400).json({ error: 'חסרים שדות חובה' });
    }

    const { data, error } = await supabase
      .from('signature_fields')
      .insert({
        document_id: req.params.docId,
        page,
        x,
        y,
        width,
        height,
        field_type: field_type || 'signature'
      })
      .select()
      .single();

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('שגיאה בשמירת שדה:', err.message);
    res.status(500).json({ error: 'שגיאה בשמירת שדה החתימה' });
  }
});

// DELETE /api/editor/:docId/fields/:fieldId
router.delete('/:docId/fields/:fieldId', requireAuth, async (req, res) => {
  try {
    if (!(await verifyOwnership(req.params.docId, req.session.userId))) {
      return res.status(403).json({ error: 'אין הרשאה למסמך זה' });
    }

    const { error } = await supabase
      .from('signature_fields')
      .delete()
      .eq('id', req.params.fieldId)
      .eq('document_id', req.params.docId);

    if (error) throw error;

    res.json({ message: 'השדה נמחק בהצלחה' });
  } catch (err) {
    console.error('שגיאה במחיקת שדה:', err.message);
    res.status(500).json({ error: 'שגיאה במחיקת שדה החתימה' });
  }
});

module.exports = router;
