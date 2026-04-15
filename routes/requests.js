const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const supabase = require('../services/supabase');
const { sendSignatureRequest } = require('../services/mailer');

// POST /api/requests/:docId/send
router.post('/:docId/send', requireAuth, async (req, res) => {
  try {
    const { recipient_email, recipient_name, signature_fields } = req.body;
    console.log('[send] docId:', req.params.docId, 'recipient:', recipient_email, 'fields:', signature_fields?.length);

    if (!recipient_email || !recipient_name) {
      return res.status(400).json({ error: 'יש להזין אימייל ושם נמען' });
    }

    // בדוק בעלות על המסמך
    console.log('[send] step 1: checking document ownership');
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id, filename')
      .eq('id', req.params.docId)
      .eq('user_id', req.session.userId)
      .single();

    if (docError || !doc) {
      console.error('[send] document not found:', docError?.message);
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }
    console.log('[send] document found:', doc.filename);

    // שמור שדות חתימה אם נשלחו מהלקוח
    if (signature_fields && signature_fields.length > 0) {
      console.log('[send] step 2: saving signature fields');
      // מחק שדות ישנים
      const { error: delError } = await supabase
        .from('signature_fields')
        .delete()
        .eq('document_id', req.params.docId);
      if (delError) console.error('[send] delete fields error:', delError.message);

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
      const { error: insertError } = await supabase.from('signature_fields').insert(fieldsToInsert);
      if (insertError) {
        console.error('[send] insert fields error:', insertError.message);
        throw insertError;
      }
      console.log('[send] fields saved:', fieldsToInsert.length);
    }

    // בדוק שיש לפחות שדה חתימה אחד
    console.log('[send] step 3: checking fields exist');
    const { data: fields, error: fieldsError } = await supabase
      .from('signature_fields')
      .select('id')
      .eq('document_id', req.params.docId);

    if (fieldsError) throw fieldsError;

    if (!fields || fields.length === 0) {
      console.log('[send] no fields found in DB');
      return res.status(400).json({ error: 'יש להוסיף לפחות חתימה אחת למסמך לפני השליחה' });
    }
    console.log('[send] fields in DB:', fields.length);

    // צור בקשת חתימה עם token
    console.log('[send] step 4: creating signature request');
    const { data: request, error: reqError } = await supabase
      .from('signature_requests')
      .insert({
        document_id: req.params.docId,
        recipient_email,
        recipient_name
      })
      .select()
      .single();

    if (reqError) {
      console.error('[send] create request error:', reqError.message);
      throw reqError;
    }
    console.log('[send] request created, token:', request.token);

    // עדכן סטטוס מסמך ל-sent
    await supabase
      .from('documents')
      .update({ status: 'sent' })
      .eq('id', req.params.docId);
    console.log('[send] step 5: status updated to sent');

    // שלח מייל
    const signUrl = `${process.env.BASE_URL}/sign/${request.token}`;
    console.log('[send] step 6: sending email to', recipient_email, 'url:', signUrl);

    let emailSent = false;
    try {
      await sendSignatureRequest(recipient_email, recipient_name, signUrl);
      emailSent = true;
      console.log('[send] email sent successfully!');
    } catch (emailErr) {
      console.error('[send] email failed (continuing):', emailErr.message);
    }

    res.json({
      message: emailSent ? 'בקשת החתימה נשלחה בהצלחה' : 'הבקשה נוצרה — המייל לא נשלח, שתף את הקישור ידנית',
      requestId: request.id,
      signUrl
    });
  } catch (err) {
    console.error('[send] FAILED at:', err.message);
    console.error('[send] full error:', err);
    res.status(500).json({ error: 'שגיאה בשליחת בקשת החתימה: ' + err.message });
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
