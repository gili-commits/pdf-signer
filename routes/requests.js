const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const supabase = require('../services/supabase');
const { sendSignatureRequest } = require('../services/mailer');

// POST /api/requests/:docId/send
router.post('/:docId/send', requireAuth, async (req, res) => {
  try {
    const { recipient_email, recipient_name } = req.body;

    if (!recipient_email || !recipient_name) {
      return res.status(400).json({ error: 'יש להזין אימייל ושם נמען' });
    }

    // בדוק בעלות על המסמך
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id, filename')
      .eq('id', req.params.docId)
      .eq('user_id', req.session.userId)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    // שמור שדות חתימה אם נשלחו מהלקוח
    const { signature_fields } = req.body;
    if (signature_fields && signature_fields.length > 0) {
      // מחק שדות ישנים
      await supabase
        .from('signature_fields')
        .delete()
        .eq('document_id', req.params.docId);

      // שמור חדשים
      const fieldsToInsert = signature_fields.map(f => ({
        document_id: req.params.docId,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        field_type: 'signature'
      }));
      await supabase.from('signature_fields').insert(fieldsToInsert);
    }

    // בדוק שיש לפחות שדה חתימה אחד
    const { data: fields, error: fieldsError } = await supabase
      .from('signature_fields')
      .select('id')
      .eq('document_id', req.params.docId);

    if (fieldsError) throw fieldsError;

    if (!fields || fields.length === 0) {
      return res.status(400).json({ error: 'יש להוסיף לפחות חתימה אחת למסמך לפני השליחה' });
    }

    // צור בקשת חתימה עם token
    const { data: request, error: reqError } = await supabase
      .from('signature_requests')
      .insert({
        document_id: req.params.docId,
        recipient_email,
        recipient_name
        // token נוצר אוטומטית ב-DB (default gen_random_uuid)
      })
      .select()
      .single();

    if (reqError) throw reqError;

    // עדכן סטטוס מסמך ל-sent
    await supabase
      .from('documents')
      .update({ status: 'sent' })
      .eq('id', req.params.docId);

    // שלח מייל
    const signUrl = `${process.env.BASE_URL}/sign/${request.token}`;
    await sendSignatureRequest(recipient_email, recipient_name, signUrl);

    res.json({ message: 'בקשת החתימה נשלחה בהצלחה', requestId: request.id });
  } catch (err) {
    console.error('שגיאה בשליחת בקשת חתימה:', err.message);
    res.status(500).json({ error: 'שגיאה בשליחת בקשת החתימה' });
  }
});

// GET /api/requests/:docId
router.get('/:docId', requireAuth, async (req, res) => {
  try {
    // בדוק בעלות
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id')
      .eq('id', req.params.docId)
      .eq('user_id', req.session.userId)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    const { data, error } = await supabase
      .from('signature_requests')
      .select('id, recipient_email, recipient_name, status, signed_at, created_at')
      .eq('document_id', req.params.docId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('שגיאה בשליפת בקשות:', err.message);
    res.status(500).json({ error: 'שגיאה בשליפת בקשות החתימה' });
  }
});

module.exports = router;
