const { PDFDocument } = require('pdf-lib');
const { downloadPdf, uploadPdf } = require('./storage');

async function embedSignature(documentStoragePath, signatures) {
  // הורד PDF מקורי
  const pdfBuffer = await downloadPdf(documentStoragePath);
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const pages = pdfDoc.getPages();

  // הטמע כל חתימה בעמוד ובמיקום המתאים
  for (const sig of signatures) {
    const page = pages[sig.page - 1]; // page הוא 1-based
    if (!page) continue;

    // המר base64 ל-PNG image
    const base64Data = sig.signatureData.replace(/^data:image\/png;base64,/, '');
    const pngImage = await pdfDoc.embedPng(Buffer.from(base64Data, 'base64'));

    const pageHeight = page.getHeight();

    page.drawImage(pngImage, {
      x: sig.x,
      y: pageHeight - sig.y - sig.height, // המרת קואורדינטות — PDF הוא bottom-up
      width: sig.width,
      height: sig.height
    });
  }

  // שמור PDF חתום
  const signedPdfBytes = await pdfDoc.save();

  // העלה חזרה — הוסף _signed לפני .pdf
  const signedPath = documentStoragePath.replace('.pdf', '_signed.pdf');
  await uploadPdf(signedPath, Buffer.from(signedPdfBytes));

  return signedPath;
}

module.exports = { embedSignature };
