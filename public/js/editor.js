console.log('editor.js loaded');

const params = new URLSearchParams(window.location.search);
const docId = params.get('doc');
if (!docId) { alert('מסמך לא נמצא'); window.location.href = '/'; }

let currentPage = 1;
let totalPages = 1;
let fabricCanvas = null;
let pagesInfo = null;
let pageObjects = {}; // שמירת אובייקטים בין עמודים

// Signature pad
let sigPadCanvas, sigPadCtx, sigDrawing = false, sigHasDrawn = false;
let sigTargetField = null; // שדה חתימה שעליו לחצו דאבל-קליק

// === אתחול ===
async function init() {
  try {
    console.log('init started, docId:', docId);
    const pagesRes = await fetch(`/api/documents/${docId}/pages`);
    console.log('pages response:', pagesRes.status);
    if (!pagesRes.ok) { alert('שגיאה בטעינת המסמך'); return; }
    pagesInfo = await pagesRes.json();
    totalPages = pagesInfo.totalPages;
    document.getElementById('page-count').textContent = totalPages;

    fabricCanvas = new fabric.Canvas('fabric-canvas', { selection: true });
    console.log('fabricCanvas created');

    // סנכרון סרגל כלים כשבוחרים אובייקט טקסט
    fabricCanvas.on('selection:created', syncToolbar);
    fabricCanvas.on('selection:updated', syncToolbar);
    fabricCanvas.on('selection:cleared', () => {
      document.getElementById('btn-bold').classList.remove('active');
    });

    // דאבל-קליק על שדה חתימה — פותח משטח ציור
    fabricCanvas.on('mouse:dblclick', (opt) => {
      const target = opt.target;
      if (target && target.objType === 'sigField') {
        sigTargetField = target;
        openSigModal();
      }
    });

    initSigPad();
    await renderPage(currentPage);
    console.log('init completed');
  } catch (err) {
    console.error('init error:', err);
  }
}

// === הוספת מלבן מחיקה (whiteout) ===
function addWhiteout() {
  const rect = new fabric.Rect({
    left: 100, top: 100, width: 200, height: 30,
    fill: '#ffffff', stroke: '#d1d5db', strokeWidth: 1,
    objType: 'whiteout'
  });
  fabricCanvas.add(rect);
  fabricCanvas.setActiveObject(rect);
  fabricCanvas.renderAll();
}

// === הוספת טקסט ===
function addText() {
  const fontSize = parseInt(document.getElementById('font-size').value) || 16;
  const color = document.getElementById('font-color').value || '#000000';
  const text = new fabric.IText('טקסט', {
    left: 100, top: 100,
    fontSize, fill: color, fontFamily: 'Arial',
    objType: 'text', editable: true
  });
  fabricCanvas.add(text);
  fabricCanvas.setActiveObject(text);
  text.enterEditing();
  text.selectAll();
  fabricCanvas.renderAll();
}

// === הוספת שדה חתימה (מסגרת עבור הנמען) ===
function addSigField() {
  const group = new fabric.Group([
    new fabric.Rect({
      width: 200, height: 60,
      fill: 'rgba(37, 99, 235, 0.05)',
      stroke: '#2563eb', strokeWidth: 2,
      strokeDashArray: [6, 4],
      rx: 4, ry: 4
    }),
    new fabric.Text('חתום כאן ✎', {
      fontSize: 14, fill: '#2563eb',
      fontFamily: 'Arial',
      originX: 'center', originY: 'center'
    })
  ], {
    left: 100, top: 100,
    objType: 'sigField'
  });
  fabricCanvas.add(group);
  fabricCanvas.setActiveObject(group);
  fabricCanvas.renderAll();
}

// === רנדור עמוד ===
async function renderPage(pageNumber) {
  saveCurrentPageObjects();

  const pdfCanvas = document.getElementById('pdf-canvas');
  const ctx = pdfCanvas.getContext('2d');

  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `/api/documents/${docId}/page/${pageNumber}`;
  });

  pdfCanvas.width = img.width;
  pdfCanvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  fabricCanvas.setWidth(img.width);
  fabricCanvas.setHeight(img.height);
  fabricCanvas.clear();

  currentPage = pageNumber;
  document.getElementById('page-num').textContent = pageNumber;

  restorePageObjects(pageNumber);
}

// === שמירה ושחזור אובייקטים בין עמודים ===
function saveCurrentPageObjects() {
  if (!fabricCanvas) return;
  const objects = [];
  fabricCanvas.getObjects().forEach(obj => {
    objects.push({
      type: obj.objType,
      data: obj.toJSON(['objType', 'sigData']),
      sigData: obj.sigData || null
    });
  });
  pageObjects[currentPage] = objects;
}

function restorePageObjects(pageNumber) {
  const objects = pageObjects[pageNumber];
  if (!objects || objects.length === 0) return;

  objects.forEach(saved => {
    if (saved.type === 'whiteout') {
      const rect = new fabric.Rect({
        left: saved.data.left, top: saved.data.top,
        width: saved.data.width, height: saved.data.height,
        scaleX: saved.data.scaleX || 1, scaleY: saved.data.scaleY || 1,
        fill: '#ffffff', stroke: '#d1d5db', strokeWidth: 1,
        objType: 'whiteout'
      });
      fabricCanvas.add(rect);
    } else if (saved.type === 'text') {
      const text = new fabric.IText(saved.data.text || '', {
        left: saved.data.left, top: saved.data.top,
        fontSize: saved.data.fontSize || 16,
        fill: saved.data.fill || '#000',
        fontWeight: saved.data.fontWeight || 'normal',
        fontFamily: 'Arial', objType: 'text', editable: true
      });
      fabricCanvas.add(text);
    } else if (saved.type === 'signature' && saved.sigData) {
      addSignedImage(saved.data.left, saved.data.top,
        (saved.data.width || 200) * (saved.data.scaleX || 1),
        (saved.data.height || 60) * (saved.data.scaleY || 1),
        saved.sigData);
    } else if (saved.type === 'sigField') {
      // שחזור שדה חתימה
      const d = saved.data;
      const group = new fabric.Group([
        new fabric.Rect({
          width: 200, height: 60,
          fill: 'rgba(37, 99, 235, 0.05)',
          stroke: '#2563eb', strokeWidth: 2,
          strokeDashArray: [6, 4],
          rx: 4, ry: 4
        }),
        new fabric.Text('חתום כאן ✎', {
          fontSize: 14, fill: '#2563eb',
          fontFamily: 'Arial',
          originX: 'center', originY: 'center'
        })
      ], {
        left: d.left, top: d.top,
        scaleX: d.scaleX || 1, scaleY: d.scaleY || 1,
        objType: 'sigField'
      });
      fabricCanvas.add(group);
    }
  });

  fabricCanvas.renderAll();
}

// === מחיקת אובייקט ===
function deleteSelected() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;
  fabricCanvas.remove(obj);
  fabricCanvas.renderAll();
}

// === חתימה עצמית ===
function addSignedImage(x, y, w, h, dataUrl) {
  fabric.Image.fromURL(dataUrl, (img) => {
    img.set({
      left: x, top: y,
      scaleX: w / img.width, scaleY: h / img.height,
      objType: 'signature', sigData: dataUrl
    });
    fabricCanvas.add(img);
    fabricCanvas.renderAll();
  });
}

// === Signature Pad ===
function initSigPad() {
  sigPadCanvas = document.getElementById('sig-modal-canvas');
  sigPadCtx = sigPadCanvas.getContext('2d');
  sigPadCtx.strokeStyle = '#000';
  sigPadCtx.lineWidth = 2.5;
  sigPadCtx.lineCap = 'round';
  sigPadCtx.lineJoin = 'round';

  sigPadCanvas.addEventListener('mousedown', sigStart);
  sigPadCanvas.addEventListener('mousemove', sigMove);
  sigPadCanvas.addEventListener('mouseup', sigStop);
  sigPadCanvas.addEventListener('mouseleave', sigStop);
  sigPadCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); sigStart(sigTouchPos(e.touches[0])); });
  sigPadCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); sigMove(sigTouchPos(e.touches[0])); });
  sigPadCanvas.addEventListener('touchend', sigStop);
}

function sigTouchPos(touch) {
  const rect = sigPadCanvas.getBoundingClientRect();
  return { offsetX: touch.clientX - rect.left, offsetY: touch.clientY - rect.top };
}
function sigStart(e) { sigDrawing = true; sigHasDrawn = true; sigPadCtx.beginPath(); sigPadCtx.moveTo(e.offsetX, e.offsetY); }
function sigMove(e) { if (!sigDrawing) return; sigPadCtx.lineTo(e.offsetX, e.offsetY); sigPadCtx.stroke(); }
function sigStop() { sigDrawing = false; }

function openSigModal() {
  // אם נקרא מכפתור "חתום בעצמך" (לא מדאבל-קליק על שדה) — אפס
  if (!sigTargetField) sigTargetField = null;
  clearSigPad();
  document.getElementById('sig-modal').classList.add('active');
}
function closeSigModal() { document.getElementById('sig-modal').classList.remove('active'); }
function clearSigPad() { sigPadCtx.clearRect(0, 0, sigPadCanvas.width, sigPadCanvas.height); sigHasDrawn = false; }

function confirmSignature() {
  if (!sigHasDrawn) { alert('יש לצייר חתימה'); return; }
  const dataUrl = sigPadCanvas.toDataURL('image/png');

  if (sigTargetField) {
    // החלף את שדה החתימה בתמונת החתימה
    const x = sigTargetField.left;
    const y = sigTargetField.top;
    const w = sigTargetField.width * (sigTargetField.scaleX || 1);
    const h = sigTargetField.height * (sigTargetField.scaleY || 1);
    fabricCanvas.remove(sigTargetField);
    addSignedImage(x, y, w, h, dataUrl);
    sigTargetField = null;
  } else {
    // חתימה חופשית (כפתור "חתום בעצמך")
    addSignedImage(100, 100, 200, 60, dataUrl);
  }
  closeSigModal();
}

// === ניווט ===
async function prevPage() { if (currentPage <= 1) return; await renderPage(currentPage - 1); }
async function nextPage() { if (currentPage >= totalPages) return; await renderPage(currentPage + 1); }

// === הורדת PDF ===
async function downloadPdf() {
  saveCurrentPageObjects();

  const allAnnotations = {};

  for (const [page, objects] of Object.entries(pageObjects)) {
    if (objects.length === 0) continue;
    const info = pagesInfo.pages[parseInt(page) - 1];
    const scaleRatio = info.originalWidth / info.width;
    const items = [];

    for (const obj of objects) {
      const d = obj.data;
      if (obj.type === 'whiteout') {
        items.push({
          type: 'whiteout',
          x: d.left * scaleRatio,
          y: d.top * scaleRatio,
          w: (d.width * (d.scaleX || 1)) * scaleRatio,
          h: (d.height * (d.scaleY || 1)) * scaleRatio
        });
      } else if (obj.type === 'text' && d.text) {
        items.push({
          type: 'text',
          x: d.left * scaleRatio,
          y: d.top * scaleRatio,
          text: d.text,
          fontSize: (d.fontSize || 16) * scaleRatio,
          color: d.fill || '#000000'
        });
      } else if (obj.type === 'signature' && obj.sigData) {
        items.push({
          type: 'image',
          x: d.left * scaleRatio,
          y: d.top * scaleRatio,
          width: (d.width || 200) * (d.scaleX || 1) * scaleRatio,
          height: (d.height || 60) * (d.scaleY || 1) * scaleRatio,
          imageData: obj.sigData
        });
      }
      // sigField אובייקטים לא נכללים בהורדה — הם רק סמן מיקום
    }
    if (items.length > 0) allAnnotations[page] = items;
  }

  const res = await fetch(`/api/documents/${docId}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotations: allAnnotations })
  });

  if (!res.ok) { alert('שגיאה בהורדת PDF'); return; }

  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'document_edited.pdf';
  a.click();
  URL.revokeObjectURL(a.href);
}

// === יצירת קישור חתימה ===
async function createSignLink() {
  // אסוף שדות חתימה (sigField) מכל העמודים
  saveCurrentPageObjects();
  const sigFields = [];
  for (const [page, objects] of Object.entries(pageObjects)) {
    const info = pagesInfo.pages[parseInt(page) - 1];
    const scaleRatio = info.originalWidth / info.width;

    objects.forEach(obj => {
      if (obj.type === 'sigField') {
        const d = obj.data;
        sigFields.push({
          page: parseInt(page),
          x: d.left * scaleRatio,
          y: d.top * scaleRatio,
          width: (d.width || 200) * (d.scaleX || 1) * scaleRatio,
          height: (d.height || 60) * (d.scaleY || 1) * scaleRatio
        });
      }
    });
  }

  if (sigFields.length === 0) {
    alert('יש להוסיף לפחות שדה חתימה אחד (כפתור "✎ שדה חתימה")');
    return;
  }

  const res = await fetch(`/api/requests/${docId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient_name: 'נמען',
      recipient_email: 'pending@sign.link',
      signature_fields: sigFields
    })
  });
  const data = await res.json();
  if (res.ok) {
    showLinkModal(data.signUrl, 'הנמען');
  }
  else { alert(data.error); }
}

// === הצגת קישור חתימה ===
function showLinkModal(url, name) {
  document.getElementById('link-recipient').textContent = name;
  document.getElementById('link-url').value = url;
  document.getElementById('link-modal').classList.add('active');
}
function closeLinkModal() { document.getElementById('link-modal').classList.remove('active'); }
function copyLink() {
  const input = document.getElementById('link-url');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = document.getElementById('btn-copy-link');
    btn.textContent = 'הועתק!';
    btn.style.background = '#16a34a';
    setTimeout(() => { btn.textContent = 'העתק קישור'; btn.style.background = '#2563eb'; }, 2000);
  });
}
function shareWhatsApp() {
  const url = document.getElementById('link-url').value;
  const name = document.getElementById('link-recipient').textContent;
  const text = encodeURIComponent(`שלום ${name}, יש מסמך שממתין לחתימתך:\n${url}`);
  window.open(`https://wa.me/?text=${text}`, '_blank');
}

// === סנכרון סרגל כלים ===
function syncToolbar() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj.objType !== 'text') return;
  document.getElementById('font-size').value = Math.round(obj.fontSize || 16);
  document.getElementById('font-color').value = obj.fill || '#000000';
  document.getElementById('btn-bold').classList.toggle('active', obj.fontWeight === 'bold');
}

// === עיצוב טקסט ===
function applyFontSize() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj.objType !== 'text') return;
  const size = parseInt(document.getElementById('font-size').value) || 16;
  obj.set('fontSize', size);
  fabricCanvas.renderAll();
}

function changeFontSize(delta) {
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj.objType !== 'text') return;
  const newSize = Math.max(8, Math.min(72, (obj.fontSize || 16) + delta));
  obj.set('fontSize', newSize);
  document.getElementById('font-size').value = newSize;
  fabricCanvas.renderAll();
}

function toggleBold() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj.objType !== 'text') return;
  const isBold = obj.fontWeight === 'bold';
  obj.set('fontWeight', isBold ? 'normal' : 'bold');
  document.getElementById('btn-bold').classList.toggle('active', !isBold);
  fabricCanvas.renderAll();
}

function applyFontColor() {
  const obj = fabricCanvas.getActiveObject();
  if (!obj || obj.objType !== 'text') return;
  obj.set('fill', document.getElementById('font-color').value);
  fabricCanvas.renderAll();
}

// מקש Delete למחיקה
document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete') {
    const obj = fabricCanvas.getActiveObject();
    if (obj && !obj.isEditing) {
      fabricCanvas.remove(obj);
      fabricCanvas.renderAll();
    }
  }
});

init();
