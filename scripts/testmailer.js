import { sendEmail } from '../src/lib/mailer.js';

(async () => {
  try {
    const info = await sendEmail({
      to: 'boymailody@gmail.com',
      subject: 'Gmail SMTP test',
      html: '<h1>Gmail SMTP TEST</h1>'
    });
    console.log('OK:', info);
  } catch (e) {
    console.error('ERR', e);
  } finally {
    process.exit(0);
  }
})();