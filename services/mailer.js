const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS
  }
});

async function sendSignatureRequest(recipientEmail, recipientName, signUrl) {
  await transporter.sendMail({
    from: `"חתימה דיגיטלית" <${process.env.GMAIL_USER}>`,
    to: recipientEmail,
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
}

async function sendSignedNotification(ownerEmail, documentName, downloadUrl) {
  await transporter.sendMail({
    from: `"חתימה דיגיטלית" <${process.env.GMAIL_USER}>`,
    to: ownerEmail,
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
}

module.exports = { sendSignatureRequest, sendSignedNotification };
