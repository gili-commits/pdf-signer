// שלוף token מה-URL
const pathParts = window.location.pathname.split('/');
const token = pathParts[pathParts.length - 1];

let currentPage = 1;
let totalPages = 1;
let signData = null; // נתונים מהשרת
let sigCanvas, sigCtx;
let isDrawing = false;
let hasDrawn = false;

// === אתחול ===
async function init() {
  try {
    const res = await fetch(`/api/sign/${token}`);
    const data = await res.json();

    if (!res.ok) {
      showError(data.error);
      return;
    }

    signData = data;
    totalPages = data.document.totalPages;
    document.getElementById('page-count').textContent = totalPages;
    document.getElementById('header-info').textContent =
      `שלום ${data.recipientName}, נא לחתום על "${data.document.filename}"`;

    // אתחל canvas חתימה
    initSignaturePad();

    // הצג תוכן
    document.getElementById('loading').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';

    await renderPage(currentPage);
  } catch (err) {
    showError('שגיאה בטעינת המסמך');
  }
}

function showError(msg) {
  document.getElementById('loading').style.display = 'none';
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.style.display = 'block';
}

// === רנדור עמוד — תמונה מהשרת (MuPDF) ===
async function renderPage(pageNumber) {
  const pdfCanvas = document.getElementById('pdf-canvas');
  const ctx = pdfCanvas.getContext('2d');

  const img = new Image();
  img.crossOrigin = 'anonymous';

  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = `/api/sign/${token}/page/${pageNumber}`;
  });

  pdfCanvas.width = img.width;
  pdfCanvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  document.getElementById('page-num').textContent = pageNumber;

  // הצג שדות חתימה על העמוד
  renderFieldOverlays(img.width, img.height);
}

function renderFieldOverlays(canvasWidth, canvasHeight) {
  // הסר overlays קיימים
  document.querySelectorAll('.field-overlay').forEach(el => el.remove());

  const container = document.getElementById('pdf-container');
  const pageFields = signData.fields.filter(f => f.page === currentPage);

  // חשב scale — היחס בין גודל ה-canvas לגודל המקורי של העמוד
  const pageInfo = signData.document.pages[currentPage - 1];
  const scale = canvasWidth / pageInfo.originalWidth;

  pageFields.forEach(field => {
    const overlay = document.createElement('div');
    overlay.className = 'field-overlay';
    overlay.style.left = (field.x * scale) + 'px';
    overlay.style.top = (field.y * scale) + 'px';
    overlay.style.width = (field.width * scale) + 'px';
    overlay.style.height = (field.height * scale) + 'px';

    const labels = { signature: 'חתום כאן', text: 'טקסט', date: 'תאריך' };
    overlay.textContent = labels[field.field_type] || 'חתום כאן';

    overlay.addEventListener('click', () => {
      document.getElementById('signature-section').scrollIntoView({ behavior: 'smooth' });
    });

    container.appendChild(overlay);
  });
}

// === ניווט עמודים ===
async function prevPage() {
  if (currentPage <= 1) return;
  currentPage--;
  await renderPage(currentPage);
}

async function nextPage() {
  if (currentPage >= totalPages) return;
  currentPage++;
  await renderPage(currentPage);
}

// === Signature Pad — ציור חתימה ===
function initSignaturePad() {
  sigCanvas = document.getElementById('sig-canvas');
  sigCtx = sigCanvas.getContext('2d');
  sigCtx.strokeStyle = '#000';
  sigCtx.lineWidth = 2.5;
  sigCtx.lineCap = 'round';
  sigCtx.lineJoin = 'round';

  // עכבר
  sigCanvas.addEventListener('mousedown', startDraw);
  sigCanvas.addEventListener('mousemove', draw);
  sigCanvas.addEventListener('mouseup', stopDraw);
  sigCanvas.addEventListener('mouseleave', stopDraw);

  // מגע (טאבלט/נייד)
  sigCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    startDraw(touchToMouse(touch));
  });
  sigCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    draw(touchToMouse(touch));
  });
  sigCanvas.addEventListener('touchend', stopDraw);
}

function touchToMouse(touch) {
  const rect = sigCanvas.getBoundingClientRect();
  return { offsetX: touch.clientX - rect.left, offsetY: touch.clientY - rect.top };
}

function startDraw(e) {
  isDrawing = true;
  hasDrawn = true;
  sigCtx.beginPath();
  sigCtx.moveTo(e.offsetX, e.offsetY);
}

function draw(e) {
  if (!isDrawing) return;
  sigCtx.lineTo(e.offsetX, e.offsetY);
  sigCtx.stroke();
}

function stopDraw() {
  isDrawing = false;
}

function clearSignature() {
  sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  hasDrawn = false;
}

// === שליחת חתימה ===
async function submitSignature() {
  if (!hasDrawn) {
    alert('יש לחתום לפני השליחה');
    return;
  }

  const signatureData = sigCanvas.toDataURL('image/png');

  // שלח חתימה לכל שדה מסוג signature
  const signatures = signData.fields
    .filter(f => f.field_type === 'signature')
    .map(f => ({
      fieldId: f.id,
      signatureData
    }));

  if (signatures.length === 0) {
    alert('לא נמצאו שדות חתימה');
    return;
  }

  try {
    const res = await fetch(`/api/sign/${token}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signatures })
    });

    const data = await res.json();

    if (res.ok) {
      document.getElementById('main-content').style.display = 'none';
      document.getElementById('success-msg').style.display = 'block';
    } else {
      alert(data.error);
    }
  } catch (err) {
    alert('שגיאה בשליחת החתימה');
  }
}

init();
