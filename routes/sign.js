const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { embedSignature } = require('../services/pdfService');
const { downloadPdf, getSignedUrl } = require('../services/storage');
const { sendSignedNotification } = require('../services/mailer');
const { renderPage, getPagesInfo } = require('../services/pdfRenderer');

// GET /api/sign/:token — שליפת פרטי מסמך ושדות (ציבורי)
router.get('/:token', async (req, res) => {
  try {
    // שלוף בקשת חתימה לפי token
    const { data: request, error: reqError } = await supabase
      .from('signature_requests')
      .select('id, document_id, recipient_name, status')
      .eq('token', req.params.token)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'קישור לא תקין' });
    }

    if (request.status === 'signed') {
      return res.status(400).json({ error: 'מסמך זה כבר נחתם' });
    }

    // שלוף פרטי מסמך
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id, filename, storage_path')
      .eq('id', request.document_id)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    // שלוף שדות חתימה
    const { data: fields, error: fieldsError } = await supabase
      .from('signature_fields')
      .select('id, page, x, y, width, height, field_type')
      .eq('document_id', doc.id)
      .order('page', { ascending: true });

    if (fieldsError) throw fieldsError;

    // שלוף מידע על עמודים
    const pdfBuffer = await downloadPdf(doc.storage_path);
    const pagesInfo = await getPagesInfo(pdfBuffer);

    res.json({
      requestId: request.id,
      recipientName: request.recipient_name,
      document: {
        id: doc.id,
        filename: doc.filename,
        totalPages: pagesInfo.totalPages,
        pages: pagesInfo.pages
      },
      fields
    });
  } catch (err) {
    console.error('שגיאה בטעינת דף חתימה:', err.message);
    res.status(500).json({ error: 'שגיאה בטעינת המסמך' });
  }
});

// GET /api/sign/:token/page/:num — רנדור עמוד כתמונה (ציבורי)
router.get('/:token/page/:num', async (req, res) => {
  try {
    const { data: request, error: reqError } = await supabase
      .from('signature_requests')
      .select('document_id, status')
      .eq('token', req.params.token)
      .single();

    if (reqError || !request || request.status === 'signed') {
      return res.status(404).json({ error: 'קישור לא תקין' });
    }

    const { data: doc } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', request.document_id)
      .single();

    const pdfBuffer = await downloadPdf(doc.storage_path);
    const pageNum = parseInt(req.params.num, 10);
    const { png } = await renderPage(pdfBuffer, pageNum);

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(png));
  } catch (err) {
    console.error('שגיאה ברנדור עמוד:', err.message);
    res.status(500).json({ error: 'שגיאה ברנדור העמוד' });
  }
});

// POST /api/sign/:token/submit — שליחת חתימה (ציבורי)
router.post('/:token/submit', async (req, res) => {
  try {
    const { signatures } = req.body;
    // signatures: [{ fieldId, signatureData (base64 PNG) }]

    if (!signatures || !Array.isArray(signatures) || signatures.length === 0) {
      return res.status(400).json({ error: 'חסרות חתימות' });
    }

    // בדוק token
    const { data: request, error: reqError } = await supabase
      .from('signature_requests')
      .select('id, document_id, status')
      .eq('token', req.params.token)
      .single();

    if (reqError || !request) {
      return res.status(404).json({ error: 'קישור לא תקין' });
    }

    if (request.status === 'signed') {
      return res.status(400).json({ error: 'מסמך זה כבר נחתם' });
    }

    // שלוף פרטי מסמך
    const { data: doc, error: docError } = await supabase
      .from('documents')
      .select('id, storage_path, filename, user_id')
      .eq('id', request.document_id)
      .single();

    if (docError || !doc) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    // שלוף שדות חתימה לקואורדינטות
    const fieldIds = signatures.map(s => s.fieldId);
    const { data: fields, error: fieldsError } = await supabase
      .from('signature_fields')
      .select('id, page, x, y, width, height')
      .in('id', fieldIds);

    if (fieldsError) throw fieldsError;

    // שמור חתימות ב-DB
    const signatureRecords = signatures.map(s => ({
      request_id: request.id,
      field_id: s.fieldId,
      signature_data: s.signatureData
    }));

    const { error: sigError } = await supabase
      .from('signatures')
      .insert(signatureRecords);

    if (sigError) throw sigError;

    // הכן נתונים להטמעה ב-PDF
    const embedData = signatures.map(s => {
      const field = fields.find(f => f.id === s.fieldId);
      return {
        page: field.page,
        x: field.x,
        y: field.y,
        width: field.width,
        height: field.height,
        signatureData: s.signatureData
      };
    });

    // שלב חתימות ב-PDF
    const signedPath = await embedSignature(doc.storage_path, embedData);

    // עדכן סטטוס בקשה
    await supabase
      .from('signature_requests')
      .update({ status: 'signed', signed_at: new Date().toISOString() })
      .eq('id', request.id);

    // עדכן סטטוס מסמך
    await supabase
      .from('documents')
      .update({ status: 'completed' })
      .eq('id', doc.id);

    // שלח מייל לבעל המסמך
    const { data: owner } = await supabase.auth.admin.getUserById(doc.user_id);
    if (owner?.user?.email) {
      const downloadUrl = await getSignedUrl(signedPath);
      await sendSignedNotification(owner.user.email, doc.filename, downloadUrl);
    }

    res.json({ message: 'המסמך נחתם בהצלחה!' });
  } catch (err) {
    console.error('שגיאה בחתימה:', err.message);
    res.status(500).json({ error: 'שגיאה בשמירת החתימה' });
  }
});

module.exports = router;
