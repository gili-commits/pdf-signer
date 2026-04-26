const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const supabase = require('../services/supabase');
const { uploadPdf, downloadPdf, getSignedUrl } = require('../services/storage');
const { renderPage, getPagesInfo, extractText } = require('../services/pdfRenderer');
const { PDFDocument, rgb } = require('pdf-lib');
const fs = require('fs');
const fontkit = require('fontkit');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('יש להעלות קובץ PDF בלבד'));
    }
  }
});

// POST /api/documents/upload
router.post('/upload', requireAuth, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'לא נבחר קובץ' });
    }

    const userId = req.session.userId;
    const fileId = uuidv4();
    const storagePath = `${userId}/${fileId}.pdf`;

    await uploadPdf(storagePath, req.file.buffer);

    const { data, error } = await supabase
      .from('documents')
      .insert({
        user_id: userId,
        filename: req.file.originalname,
        storage_path: storagePath,
        status: 'draft'
      })
      .select()
      .single();

    if (error) throw error;

    res.json({ documentId: data.id, filename: data.filename });
  } catch (err) {
    console.error('שגיאה בהעלאת מסמך:', err.message);
    res.status(500).json({ error: 'שגיאה בהעלאת המסמך' });
  }
});

// GET /api/documents
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('id, filename, status, created_at')
      .eq('user_id', req.session.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(data);
  } catch (err) {
    console.error('שגיאה בשליפת מסמכים:', err.message);
    res.status(500).json({ error: 'שגיאה בשליפת המסמכים' });
  }
});

// GET /api/documents/:id/url — signed URL להורדה
router.get('/:id/url', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    const url = await getSignedUrl(data.storage_path);
    res.json({ url });
  } catch (err) {
    console.error('שגיאה ביצירת קישור:', err.message);
    res.status(500).json({ error: 'שגיאה ביצירת קישור להורדה' });
  }
});

// GET /api/documents/:id/pages — מידע על עמודים
router.get('/:id/pages', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    const pdfBuffer = await downloadPdf(data.storage_path);
    const info = await getPagesInfo(pdfBuffer);
    res.json(info);
  } catch (err) {
    console.error('שגיאה בשליפת מידע עמודים:', err.message);
    res.status(500).json({ error: 'שגיאה בשליפת מידע העמודים' });
  }
});

// GET /api/documents/:id/page/:num — רנדור עמוד כתמונה
router.get('/:id/page/:num', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    const pdfBuffer = await downloadPdf(data.storage_path);
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

// GET /api/documents/:id/page/:num/text — חילוץ טקסט מעמוד
router.get('/:id/page/:num/text', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    const pdfBuffer = await downloadPdf(data.storage_path);
    const pageNum = parseInt(req.params.num, 10);
    const lines = await extractText(pdfBuffer, pageNum);
    res.json(lines);
  } catch (err) {
    console.error('שגיאה בחילוץ טקסט:', err.message);
    res.status(500).json({ error: 'שגיאה בחילוץ טקסט' });
  }
});

// POST /api/documents/:id/download — הורדת PDF עם הערות (חתימות + טקסט)
router.post('/:id/download', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('storage_path, filename')
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    const pdfBuffer = await downloadPdf(data.storage_path);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);
    const pages = pdfDoc.getPages();
    const { annotations } = req.body;

    // טען פונט עברי
    let hebrewFont = null;
    const fontPaths = [
      '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
      '/System/Library/Fonts/Supplemental/Arial Hebrew.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'
    ];
    for (const fp of fontPaths) {
      try {
        if (fs.existsSync(fp)) {
          const fontBytes = fs.readFileSync(fp);
          hebrewFont = await pdfDoc.embedFont(fontBytes, { subset: true });
          break;
        }
      } catch (e) { /* try next */ }
    }

    if (annotations) {
      for (const [pageNumStr, items] of Object.entries(annotations)) {
        const pageIndex = parseInt(pageNumStr) - 1;
        const page = pages[pageIndex];
        if (!page) continue;
        const pageHeight = page.getHeight();

        for (const item of items) {
          if (item.type === 'image' && item.imageData) {
            const base64 = item.imageData.replace(/^data:image\/png;base64,/, '');
            const pngImage = await pdfDoc.embedPng(Buffer.from(base64, 'base64'));
            page.drawImage(pngImage, {
              x: item.x,
              y: pageHeight - item.y - item.height,
              width: item.width,
              height: item.height
            });
          } else if (item.type === 'whiteout') {
            // מחיקת טקסט — מלבן לבן
            page.drawRectangle({
              x: item.x,
              y: pageHeight - item.y - item.h,
              width: item.w,
              height: item.h,
              color: rgb(1, 1, 1),
              borderWidth: 0
            });
          } else if (item.type === 'text' && item.text) {
            const hexColor = item.color || '#000000';
            const r = parseInt(hexColor.slice(1, 3), 16) / 255;
            const g = parseInt(hexColor.slice(3, 5), 16) / 255;
            const b = parseInt(hexColor.slice(5, 7), 16) / 255;

            const drawOptions = {
              x: item.x,
              y: pageHeight - item.y - item.fontSize,
              size: item.fontSize || 16,
              color: rgb(r, g, b)
            };

            if (hebrewFont) {
              drawOptions.font = hebrewFont;
            }

            page.drawText(item.text, drawOptions);
          }
        }
      }
    }

    const editedPdf = await pdfDoc.save();

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="${data.filename.replace('.pdf', '_edited.pdf')}"`);
    res.send(Buffer.from(editedPdf));
  } catch (err) {
    console.error('שגיאה בהורדת PDF:', err.message);
    res.status(500).json({ error: 'שגיאה ביצירת הקובץ' });
  }
});

// DELETE /api/documents/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('documents')
      .select('storage_path')
      .eq('id', req.params.id)
      .eq('user_id', req.session.userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'מסמך לא נמצא' });
    }

    // מחיקה מ-Storage — מקורי + חתום (אם קיים)
    const pathsToDelete = [data.storage_path];
    const signedPath = data.storage_path.replace('.pdf', '_signed.pdf');
    pathsToDelete.push(signedPath);

    await supabase.storage.from('pdfs').remove(pathsToDelete);
    // לא נכשל גם אם הקבצים לא קיימים

    // מחיקה מ-DB (cascade ימחק גם signature_fields ו-signature_requests)
    const { error: dbError } = await supabase
      .from('documents')
      .delete()
      .eq('id', req.params.id);

    if (dbError) throw dbError;

    res.json({ message: 'המסמך נמחק בהצלחה' });
  } catch (err) {
    console.error('שגיאה במחיקת מסמך:', err.message);
    res.status(500).json({ error: 'שגיאה במחיקת המסמך' });
  }
});

module.exports = router;
