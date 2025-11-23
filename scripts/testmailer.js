import { sendEmail } from '../src/lib/mailer.js';
import { config } from '../src/config.js';

config.mail = {
  host: 'smtp-relay.brevo.com',
  port: 587,
  user: '9c5258001@smtp-brevo.com',
  pass: 'DQMl5xgNtCYG6avd',
  from: 'RTSMM-TH <no-reply@rtsmm-th.com>',
  secure: false,            // ใช้ STARTTLS port 587
  debug: true               // อยากเห็น log SMTP
};

(async () => {
  try {
    const info = await sendEmail({
      to: 'boymailody@gmail.com',
      subject: 'Brevo SMTP test',
      html: '<h1>Brevo SMTP TEST</h1><p>ส่งจาก scripts/testmailer.js</p>'
    });
    console.log('OK:', info);
  } catch (e) {
    console.error('ERR', e);
  } finally {
    process.exit(0);
  }
})();