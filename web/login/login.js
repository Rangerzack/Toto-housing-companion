import { signIn, validateEmail, redirectIfSignedIn, safeNextPath } from '../auth.js?v=__BUILD__';
import { $, setMessage, setFieldError, busy } from '../account-ui.js?v=__BUILD__';

// Someone already signed in has no business on this page; send them on,
// honouring ?next= if it points somewhere on this site.
redirectIfSignedIn('../dashboard/');

const form = $('#login-form');
const message = $('#form-message');
const submit = $('#submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(message, '');

  const email = $('#email').value;
  const password = $('#password').value;

  // Only the email is format-checked here. Deliberately NOT the password: the
  // rules for a new password belong on the signup form, and telling someone
  // their existing password is "too short" to even attempt is both wrong and
  // a hint about what is stored.
  const emailError = validateEmail(email);
  setFieldError($('#field-email'), emailError);
  setFieldError($('#field-password'), password ? null : 'Enter your password.');
  if (emailError || !password) {
    ($('#email').value && password ? $('#password') : $('#email')).focus();
    return;
  }

  const done = busy(submit, 'Signing in…');
  try {
    await signIn({ email, password });
    const next = safeNextPath(new URLSearchParams(location.search).get('next'), null);
    // replace(), not assign(): Back from the dashboard should reach the
    // screener, never bounce through a login page the person has finished with.
    location.replace(next || '../dashboard/');
  } catch (error) {
    done();
    setMessage(message, error.message);
    $('#password').value = '';
    $('#password').focus();
  }
});
