const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

// כתובת השולח — ברירת מחדל של Resend או דומיין מאומת
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

async function sendSignatureRequest(recipientEmail, recipientName, signUrl) {
  const { error } = await resend.emails.send({
    from: `חתימה דיגיטלית <${FROM_EMAIL}>`,
    to: [recipientEmail],
    subject: 'בקשה לחתימה על מסמך',
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif;">
        <h2>שלום ${recipientName},</h2>
        <p>קיבלת בקשה לחתימה על מסמך.</p>
        <p>
          <a href="${signUrl}"
             style="display:inline-block; padding:12px 24px; background:#2563eb; color:#fff; text-decoration:none; border-radius:6px;">
            לחתימה על המסמך
          </a>
        </p>
        <p style="color:#666; font-size:14px;">קישור זה חד-פעמי ותקף לשימוש יחיד.</p>
      </div>
    `
  });

  if (error) {
    console.error('Resend error:', error);
    throw new Error(error.message);
  }
}

async function sendSignedNotification(ownerEmail, documentName, downloadUrl) {
  const { error } = await resend.emails.send({
    from: `חתימה דיגיטלית <${FROM_EMAIL}>`,
    to: [ownerEmail],
    subject: `המסמך "${documentName}" נחתם בהצלחה`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif;">
        <h2>המסמך נחתם!</h2>
        <p>הלקוח חתם על המסמך <strong>"${documentName}"</strong>.</p>
        <p>
          <a href="${downloadUrl}"
             style="display:inline-block; padding:12px 24px; background:#16a34a; color:#fff; text-decoration:none; border-radius:6px;">
            הורדת המסמך החתום
          </a>
        </p>
        <p style="color:#666; font-size:14px;">הקישור תקף ל-60 דקות.</p>
      </div>
    `
  });

  if (error) {
    console.error('Resend error:', error);
    throw new Error(error.message);
  }
}

module.exports = { sendSignatureRequest, sendSignedNotification };
