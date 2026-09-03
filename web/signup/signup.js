import { signUp, validateEmail, validatePassword, redirectIfSignedIn, isSignedIn } from '../auth.js?v=__BUILD__';
import { $, el, setMessage, setFieldError, busy } from '../account-ui.js?v=__BUILD__';

redirectIfSignedIn('../dashboard/');

const form = $('#signup-form');
const message = $('#form-message');
const submit = $('#submit');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage(message, '');

  const email = $('#email').value;
  const password = $('#password').value;
  const confirm = $('#confirm').value;

  const emailError = validateEmail(email);
  const passwordError = validatePassword(password);
  const confirmError = password && confirm !== password ? 'Both passwords need to match.' : null;

  setFieldError($('#field-email'), emailError);
  setFieldError($('#field-password'), passwordError);
  setFieldError($('#field-confirm'), confirmError);
  if (emailError || passwordError || confirmError) {
    const firstBad = emailError ? '#email' : passwordError ? '#password' : '#confirm';
    $(firstBad).focus();
    return;
  }

  const done = busy(submit, 'Creating your account…');
  try {
    const { needsConfirmation } = await signUp({ email, password });

    if (needsConfirmation && !isSignedIn()) {
      // Email confirmation is on. There is no session yet, so the honest thing
      // is to stop here and say so rather than bouncing to a dashboard that
      // would immediately throw them back to the login page.
      showConfirmationNotice(email);
      return;
    }
    // Confirmation is off: they are signed in already, so go straight to
    // building the profile, which is the whole point of making an account.
    location.replace('../profile/?welcome=1');
  } catch (error) {
    done();
    setMessage(message, error.message);
    if (/already/i.test(error.message)) {
      $('#email').focus();
      $('#email').select();
    }
  }
});

/** Replaces the form with "go and check your email". */
function showConfirmationNotice(email) {
  const card = $('#signup-card');
  card.replaceChildren(
    el('h1', { class: 'account-card__title', text: 'Check your email' }),
    el('p', { class: 'account-card__lead' }, [
      'We sent a confirmation link to ',
      // textContent via el()'s text handling — never innerHTML with an address
      // someone just typed.
      el('strong', { text: email }),
      '. Open it to finish setting up your account.',
    ]),
    el('p', { class: 'form-message form-message--good', role: 'status',
      text: 'The link expires after a while. If it does, you can sign in and ask for a new one.' }),
    el('p', { class: 'account-alt' }, [
      'Nothing arrived? Check your spam folder, or ',
      el('a', { href: '../signup/', text: 'try a different address' }),
      '.',
    ]),
    el('p', { class: 'account-alt' }, [
      el('a', { href: '../login/', text: 'Back to sign in' }),
    ]),
    el('p', { class: 'account-why', text:
      'You can keep using the screener while you wait — it works without an account.' }),
  );
  card.querySelector('.account-card__title').focus?.();
}
