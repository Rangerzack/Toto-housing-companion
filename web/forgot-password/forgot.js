import {
  requestPasswordReset,
  updatePassword,
  consumeAuthHash,
  validateEmail,
  validatePassword,
} from '../auth.js?v=__BUILD__';
import { $, el, setMessage, setFieldError, busy } from '../account-ui.js?v=__BUILD__';

const requestCard = $('#request-card');
const resetCard = $('#reset-card');

// Arriving from the email link puts a one-time token in the fragment.
// consumeAuthHash() stores it and strips it from the address bar before
// anything renders, so a live token is never left sitting in the URL.
let mode = null;
try {
  mode = consumeAuthHash();
} catch (error) {
  // An expired or already-used link reports itself the same way.
  setMessage($('#request-message'), error.message);
}

if (mode === 'recovery' || mode === 'session') {
  requestCard.hidden = true;
  resetCard.hidden = false;
  $('#new-password').focus();
}

// --- Ask for the email ------------------------------------------------------

$('#request-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#request-message');
  setMessage(message, '');

  const email = $('#email').value;
  const emailError = validateEmail(email);
  setFieldError($('#field-email'), emailError);
  if (emailError) {
    $('#email').focus();
    return;
  }

  const done = busy($('#request-submit'), 'Sending…');
  try {
    // Back to this same page, which is why both states live here: exactly one
    // URL needs to be on Supabase's redirect allow-list.
    const redirectTo = `${location.origin}${location.pathname}`;
    await requestPasswordReset(email, redirectTo);

    requestCard.replaceChildren(
      el('h1', { class: 'account-card__title', text: 'Check your email' }),
      el('p', { class: 'account-card__lead' }, [
        'If ',
        el('strong', { text: email.trim() }),
        // Deliberately conditional. Confirming whether an address has an
        // account would turn this form into a way to test which emails are
        // registered.
        ' has an account, a reset link is on its way. It expires in an hour.',
      ]),
      el('p', { class: 'account-alt' }, [el('a', { href: '../login/', text: 'Back to sign in' })]),
    );
  } catch (error) {
    done();
    setMessage(message, error.message);
  }
});

// --- Set the new password ---------------------------------------------------

$('#reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = $('#reset-message');
  setMessage(message, '');

  const password = $('#new-password').value;
  const confirm = $('#new-confirm').value;
  const passwordError = validatePassword(password);
  const confirmError = password && confirm !== password ? 'Both passwords need to match.' : null;

  setFieldError($('#field-new'), passwordError);
  setFieldError($('#field-new-confirm'), confirmError);
  if (passwordError || confirmError) {
    $(passwordError ? '#new-password' : '#new-confirm').focus();
    return;
  }

  const done = busy($('#reset-submit'), 'Saving…');
  try {
    await updatePassword(password);
    resetCard.replaceChildren(
      el('h1', { class: 'account-card__title', text: 'Password updated' }),
      el('p', { class: 'account-card__lead', text: 'You’re signed in and ready to go.' }),
      el('p', { class: 'account-actions' }, [
        el('a', { class: 'btn btn--primary btn--lg', href: '../dashboard/', text: 'Go to your dashboard' }),
      ]),
    );
  } catch (error) {
    done();
    setMessage(message, error.message);
    // An expired token means starting over, so offer that rather than leaving
    // them retyping a password into a form that cannot succeed.
    if (/expired|sign in again/i.test(error.message)) {
      resetCard.hidden = true;
      requestCard.hidden = false;
      setMessage($('#request-message'), 'That link has expired. Enter your email for a fresh one.');
    }
  }
});
