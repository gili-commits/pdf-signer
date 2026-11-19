FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DB_PATH=/data/diet.db \
    BACKUP_DIR=/data/backups

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY diet ./diet
COPY static ./static
COPY make_icons.py .
RUN python make_icons.py

# משתמש לא-root; /data נוצר כאן כדי שה-volume יקבל את ההרשאות הנכונות בפעם הראשונה
RUN useradd --uid 10001 --create-home app && mkdir -p /data/backups && chown -R app:app /data
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"

# proxy-headers: ה-IP האמיתי מגיע מ-tailscale serve (X-Forwarded-For) — נחוץ ל-rate limit.
# בטוח לסמוך על הכותרת כי רק קונטיינר ה-tailscale מגיע לשירות (רשת internal).
CMD ["uvicorn", "diet.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--proxy-headers", "--forwarded-allow-ips=*", "--no-server-header"]
