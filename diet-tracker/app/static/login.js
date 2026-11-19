document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  const btn = e.target.querySelector('button');
  err.textContent = '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (r.ok) { location.replace('/'); return; }
    const j = await r.json().catch(() => ({}));
    err.textContent = typeof j.detail === 'string' ? j.detail : 'שגיאה בהתחברות';
  } catch {
    err.textContent = 'אין חיבור לשרת';
  } finally {
    btn.disabled = false;
  }
});
