const supabase = require('./supabase');

const BUCKET = 'pdfs';

async function uploadPdf(storagePath, fileBuffer, contentType = 'application/pdf') {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fileBuffer, {
      contentType,
      upsert: true
    });

  if (error) throw new Error(`שגיאה בהעלאת קובץ: ${error.message}`);
  return data.path;
}

async function downloadPdf(storagePath) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .download(storagePath);

  if (error) throw new Error(`שגיאה בהורדת קובץ: ${error.message}`);

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function getSignedUrl(storagePath, expiresInSeconds = 60 * 60 * 24 * 7) {
  // ברירת מחדל: שבוע (604800 שניות)
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error) throw new Error(`שגיאה ביצירת קישור: ${error.message}`);
  return data.signedUrl;
}

module.exports = { uploadPdf, downloadPdf, getSignedUrl };
