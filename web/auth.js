// ---------------------------------------------------------------------------
// Accounts — Supabase Auth, spoken directly
// ---------------------------------------------------------------------------
// This app has no build step and no dependencies: every other Supabase call it
// makes is a hand-written fetch against PostgREST (see fetchPrograms in
// app.js). Auth follows the same rule and talks to the GoTrue REST API rather
// than shipping the supabase-js bundle from a CDN, which would add a
// third-party origin and ~120KB to a site whose whole point is loading fast on
// a phone with one bar.
//
// What that means we own here: storing the session, refreshing the access
// token before it expires, and turning GoTrue's error strings into sentences a
// person can act on. Passwords themselves are never our problem — they go
// straight to Supabase over TLS, are hashed there, and never touch this file,
// localStorage, or any log line.
//
// Threat note on storage: the session lives in localStorage so that "stay
// signed in" survives a closed tab, which is the behaviour people expect and
// what the brief asked for. That trades off against XSS — any script running
// on this origin could read it. The mitigations that matter are elsewhere and
// are load-bearing: this app renders every piece of user and program data with
// textContent (never innerHTML), so profile text cannot become script.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=__BUILD__';

const AUTH_URL = `${SUPABASE_URL}/auth/v1`;
const REST_URL = `${SUPABASE_URL}/rest/v1`;

// Versioned: if the stored shape ever changes, old sessions are ignored rather
// than half-read.
const STORAGE_KEY = 'toto.session.v1';

// Refresh this far before the token actually expires, so a request never races
// the expiry. GoTrue's default access token lasts an hour.
const REFRESH_MARGIN_MS = 60_000;

const BASE_HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

/** @returns {{access_token: string, refresh_token: string, expires_at: number, user: object}|null} */
export function getSession() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private mode / storage disabled. Sign-in still works for this page load;
    // it just will not persist.
    return memorySession;
  }
  if (!raw) return memorySession;
  try {
    const session = JSON.parse(raw);
    if (!session?.access_token || !session?.refresh_token) return null;
    return session;
  } catch {
    return null;
  }
}

// Fallback when localStorage throws (Safari private mode, embedded webviews).
let memorySession = null;

function saveSession(payload) {
  if (!payload?.access_token) return null;
  const session = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    // GoTrue sends expires_in (seconds). Store an absolute instant so a clock
    // comparison is all that is needed later.
    expires_at: Date.now() + (Number(payload.expires_in) || 3600) * 1000,
    user: payload.user || null,
  };
  memorySession = session;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* memory-only for this page load */
  }
  return session;
}

function clearSession() {
  memorySession = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function currentUser() {
  return getSession()?.user || null;
}

export function isSignedIn() {
  return Boolean(getSession());
}

// ---------------------------------------------------------------------------
// Error messages
// ---------------------------------------------------------------------------
// GoTrue's strings are written for developers ("Invalid login credentials",
// "AuthApiError"). Someone trying to find housing while stressed gets a
// sentence that tells them what to do instead.
const FRIENDLY_ERRORS = [
  [/invalid login credentials/i, 'That email and password don’t match an account. Check for typos, or reset your password below.'],
  [/email not confirmed/i, 'Please confirm your email first — check your inbox for the link we sent.'],
  [/user already registered|already been registered/i, 'There’s already an account with that email. Try signing in instead.'],
  [/password should be at least|weak.?password/i, 'Please choose a password of at least 8 characters.'],
  [/rate limit|too many requests/i, 'Too many attempts just now. Please wait a minute and try again.'],
  [/unable to validate email|invalid.*email/i, 'That doesn’t look like a valid email address.'],
  [/token has expired|invalid.*token/i, 'That link has expired. Request a new password reset email below.'],
  [/same.*password|different from the old/i, 'Please choose a password you haven’t used on this account before.'],
];

function friendlyMessage(raw, fallback) {
  const text = String(raw || '');
  for (const [pattern, message] of FRIENDLY_ERRORS) {
    if (pattern.test(text)) return message;
  }
  return text && text.length < 160 ? text : fallback;
}

export class AuthError extends Error {
  constructor(message, { status = 0, raw = '' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.raw = raw;
  }
}

async function readError(response, fallback) {
  let raw = '';
  try {
    const body = await response.json();
    // GoTrue is inconsistent about which field carries the text.
    raw = body.error_description || body.msg || body.message || body.error || '';
  } catch {
    raw = '';
  }
  return new AuthError(friendlyMessage(raw, fallback), { status: response.status, raw });
}

// A failed fetch (offline, DNS, blocked) is not the same as a rejected
// password, and saying so saves people retyping a correct one.
function networkError() {
  return new AuthError(
    'Couldn’t reach the server. Check your connection and try again.',
    { status: 0 },
  );
}

// ---------------------------------------------------------------------------
// Validation (client side — the database enforces its own constraints too)
// ---------------------------------------------------------------------------

export const MIN_PASSWORD_LENGTH = 8;

export function validateEmail(email) {
  const value = (email || '').trim();
  if (!value) return 'Enter your email address.';
  // Deliberately loose: the only authority on whether an address works is
  // whether the confirmation email arrives. This catches typos, not RFC edge
  // cases, and must not reject valid unusual addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'That doesn’t look like a valid email address.';
  return null;
}

export function validatePassword(password) {
  const value = password || '';
  if (!value) return 'Choose a password.';
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (value.length > 72) {
    // bcrypt truncates past 72 bytes; saying so beats silently ignoring the
    // rest of what someone typed.
    return 'Please use 72 characters or fewer.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sign up / in / out
// ---------------------------------------------------------------------------

/**
 * Registers an account.
 * @returns {{needsConfirmation: boolean, user: object|null}}
 */
export async function signUp({ email, password }) {
  let response;
  try {
    response = await fetch(`${AUTH_URL}/signup`, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({ email: (email || '').trim(), password }),
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) throw await readError(response, 'Couldn’t create that account. Please try again.');

  const body = await response.json();
  // With "Confirm email" on (the Supabase default) there is no session yet —
  // the account exists but is unusable until the link is clicked. With it off,
  // signup returns a session and the person is already in.
  if (body.access_token) {
    saveSession(body);
    return { needsConfirmation: false, user: body.user || null };
  }
  return { needsConfirmation: true, user: body.user || body || null };
}

export async function signIn({ email, password }) {
  let response;
  try {
    response = await fetch(`${AUTH_URL}/token?grant_type=password`, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({ email: (email || '').trim(), password }),
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) throw await readError(response, 'Couldn’t sign in. Please try again.');

  const body = await response.json();
  const session = saveSession(body);
  if (!session) throw new AuthError('Signed in, but no session came back. Please try again.');
  return session;
}

/**
 * Ends the session. The local session is cleared even if the server call
 * fails: someone who clicked "Log out" on a shared computer must end up
 * logged out of this browser regardless of what the network did.
 */
export async function signOut() {
  const session = getSession();
  clearSession();
  if (!session) return;
  try {
    await fetch(`${AUTH_URL}/logout`, {
      method: 'POST',
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    /* already gone locally, which is what matters */
  }
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Sends the reset email.
 *
 * `redirectTo` must be on the project's allow-list (Supabase → Authentication →
 * URL Configuration → Redirect URLs) or the link in the email lands on the
 * site root with no token. See web/README.md.
 *
 * Always resolves, even for an address with no account: telling an anonymous
 * caller which emails are registered turns this form into a user-enumeration
 * oracle. Supabase behaves the same way, and the page says "if that address
 * has an account" rather than "sent".
 */
export async function requestPasswordReset(email, redirectTo) {
  try {
    const response = await fetch(`${AUTH_URL}/recover`, {
      method: 'POST',
      headers: BASE_HEADERS,
      body: JSON.stringify({ email: (email || '').trim(), redirect_to: redirectTo }),
    });
    // A rate limit is worth surfacing; anything else is swallowed on purpose so
    // the response cannot be used to probe for registered addresses.
    if (response.status === 429) {
      throw await readError(response, 'Too many attempts. Please wait a minute.');
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw networkError();
  }
}

/**
 * Reads the one-time session Supabase puts in the URL fragment when someone
 * follows a recovery link, and clears it from the address bar immediately —
 * a fragment holding a live access token should not sit in the URL where it
 * can be screenshotted, shared, or read out of the address bar over someone's
 * shoulder. (Fragments are never sent to a server, which is why Supabase uses
 * one, but the browser still displays it.)
 *
 * @returns {'recovery'|null} the flow the link was for
 */
export function consumeAuthHash() {
  const hash = location.hash || '';
  if (!hash.includes('access_token=')) {
    // Supabase reports failures the same way (#error=...&error_description=).
    if (hash.includes('error=')) {
      const params = new URLSearchParams(hash.slice(1));
      const description = params.get('error_description') || params.get('error') || '';
      history.replaceState(null, '', location.pathname + location.search);
      throw new AuthError(friendlyMessage(description, 'That link is no longer valid. Request a new one below.'));
    }
    return null;
  }

  const params = new URLSearchParams(hash.slice(1));
  const type = params.get('type');
  saveSession({
    access_token: params.get('access_token'),
    refresh_token: params.get('refresh_token'),
    expires_in: params.get('expires_in'),
    user: null,
  });
  history.replaceState(null, '', location.pathname + location.search);
  return type === 'recovery' ? 'recovery' : 'session';
}

/** Sets a new password for the signed-in (or recovery-link) session. */
export async function updatePassword(password) {
  const token = await getAccessToken();
  if (!token) throw new AuthError('That link has expired. Request a new password reset email.');

  let response;
  try {
    response = await fetch(`${AUTH_URL}/user`, {
      method: 'PUT',
      headers: { ...BASE_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password }),
    });
  } catch {
    throw networkError();
  }
  if (!response.ok) throw await readError(response, 'Couldn’t update your password. Please try again.');
  const body = await response.json();
  // Keep whatever profile info came back, but the session itself stands.
  const session = getSession();
  if (session && body?.id) {
    session.user = body;
    memorySession = session;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* memory-only */
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

// Refresh tokens rotate: using one twice invalidates the pair and signs the
// person out. Two parallel API calls both finding an expired token would do
// exactly that, so every caller waits on the same in-flight refresh.
let refreshInFlight = null;

async function refreshSession(session) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    let response;
    try {
      response = await fetch(`${AUTH_URL}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: BASE_HEADERS,
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
    } catch {
      // Offline: keep the session. The token may still be valid, and throwing
      // people back to the login screen every time the wifi drops is worse
      // than letting the next request fail.
      return session;
    }
    if (!response.ok) {
      // The refresh token is genuinely dead (revoked, reused, expired).
      clearSession();
      return null;
    }
    return saveSession(await response.json());
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** A valid access token, refreshed if it is close to expiring. */
export async function getAccessToken() {
  const session = getSession();
  if (!session) return null;
  if (session.expires_at && session.expires_at - Date.now() > REFRESH_MARGIN_MS) {
    return session.access_token;
  }
  const refreshed = await refreshSession(session);
  return refreshed?.access_token || null;
}

/**
 * Fetch against PostgREST as the signed-in user.
 *
 * The JWT is what RLS reads: every policy in 0016_user_accounts.sql is scoped
 * to auth.uid(), so this token is the only reason a row comes back at all. A
 * 401 gets one retry after a forced refresh, covering the case where the token
 * expired between the check above and the request landing.
 */
export async function authedFetch(path, options = {}, { retry = true } = {}) {
  const token = await getAccessToken();
  if (!token) throw new AuthError('Please sign in again.', { status: 401 });

  let response;
  try {
    response = await fetch(`${REST_URL}/${path}`, {
      ...options,
      headers: {
        ...BASE_HEADERS,
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
  } catch {
    throw networkError();
  }

  if (response.status === 401 && retry) {
    const session = getSession();
    if (session) {
      const refreshed = await refreshSession({ ...session, expires_at: 0 });
      if (refreshed) return authedFetch(path, options, { retry: false });
    }
    throw new AuthError('Your session expired. Please sign in again.', { status: 401 });
  }

  return response;
}

// ---------------------------------------------------------------------------
// Page guards
// ---------------------------------------------------------------------------

/**
 * Gate for the pages that show personal data.
 *
 * This is a redirect for the person's benefit, not the security boundary —
 * the boundary is RLS in the database, which returns nothing without a valid
 * JWT no matter what the browser does. Someone who edits this out of the
 * JavaScript still gets an empty page.
 *
 * `next` carries where they were headed so signing in returns them there. Only
 * the path is kept, and only a same-site one: putting a full URL in a query
 * parameter that something later redirects to is how open-redirect bugs get
 * built.
 */
export function requireAuth({ loginPath = '../login/' } = {}) {
  if (isSignedIn()) return true;
  const next = encodeURIComponent(location.pathname + location.search);
  location.replace(`${loginPath}?next=${next}`);
  return false;
}

/** Where to go after signing in — same-origin paths only. */
export function safeNextPath(raw, fallback) {
  const value = raw || '';
  // Must be a site-root-relative path. Rejects "//evil.com" (protocol-relative,
  // which browsers treat as absolute) and anything with a scheme.
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  // A backslash is treated as a path separator by some browsers
  // ("/\\evil.com"), and control characters or whitespace can smuggle one
  // past a naive check, so none of them are allowed through.
  if (/[\\\s]/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return fallback;
  return value;
}

/** Sends an already-signed-in visitor away from login/signup. */
export function redirectIfSignedIn(target = '../dashboard/') {
  if (!isSignedIn()) return false;
  const next = safeNextPath(new URLSearchParams(location.search).get('next'), null);
  location.replace(next || target);
  return true;
}
