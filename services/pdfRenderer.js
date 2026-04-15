// services/pdfRenderer.js — רנדור PDF לתמונות עם MuPDF (תמיכה מלאה בעברית)

let mupdf = null;

async function getMupdf() {
  if (!mupdf) {
    mupdf = await import('mupdf');
  }
  return mupdf;
}

async function renderPage(pdfBuffer, pageNumber, scale = 2) {
  const m = await getMupdf();
  const doc = m.Document.openDocument(pdfBuffer, 'application/pdf');
  const page = doc.loadPage(pageNumber - 1); // 0-based

  const bounds = page.getBounds();
  const width = bounds[2] - bounds[0];
  const height = bounds[3] - bounds[1];

  const matrix = m.Matrix.scale(scale, scale);
  const pixmap = page.toPixmap(matrix, m.ColorSpace.DeviceRGB, false, true);
  const pngBuffer = pixmap.asPNG();

  const pageInfo = {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    originalWidth: width,
    originalHeight: height
  };

  doc.destroy();

  return { png: pngBuffer, info: pageInfo };
}

async function getPageCount(pdfBuffer) {
  const m = await getMupdf();
  const doc = m.Document.openDocument(pdfBuffer, 'application/pdf');
  const count = doc.countPages();
  doc.destroy();
  return count;
}

async function getPagesInfo(pdfBuffer, scale = 2) {
  const m = await getMupdf();
  const doc = m.Document.openDocument(pdfBuffer, 'application/pdf');
  const count = doc.countPages();
  const pages = [];

  for (let i = 0; i < count; i++) {
    const page = doc.loadPage(i);
    const bounds = page.getBounds();
    pages.push({
      width: Math.round((bounds[2] - bounds[0]) * scale),
      height: Math.round((bounds[3] - bounds[1]) * scale),
      originalWidth: bounds[2] - bounds[0],
      originalHeight: bounds[3] - bounds[1]
    });
  }

  doc.destroy();
  return { totalPages: count, pages };
}

async function extractText(pdfBuffer, pageNumber) {
  const m = await getMupdf();
  const doc = m.Document.openDocument(pdfBuffer, 'application/pdf');
  const page = doc.loadPage(pageNumber - 1);
  const stext = page.toStructuredText('preserve-whitespace');
  const json = JSON.parse(stext.asJSON());
  doc.destroy();

  // המר למבנה פשוט — רשימת שורות עם מיקום
  const lines = [];
  for (const block of json.blocks) {
    if (block.type !== 'text') continue;
    for (const line of block.lines) {
      lines.push({
        text: line.text,
        x: line.bbox.x,
        y: line.bbox.y,
        w: line.bbox.w,
        h: line.bbox.h,
        fontSize: line.font.size,
        fontName: line.font.name,
        fontFamily: line.font.family
      });
    }
  }

  return lines;
}

module.exports = { renderPage, getPageCount, getPagesInfo, extractText };
