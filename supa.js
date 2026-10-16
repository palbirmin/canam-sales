// Tiny Supabase client (sign-in + database calls) shared by the add-on and the phone page.
// The password is only sent to Supabase to sign in; afterwards just the session tokens are kept.

export class AuthError extends Error {
  constructor(message, signedOut = false) { super(message); this.signedOut = signedOut; }
}

const TIMEOUT_MS = 20 * 1000;

// load() -> saved session or null; save(session | null) stores or clears it.
export function makeSupa({ url, key, load, save }) {
  let refreshing = null;

  async function call(path, { method = 'GET', token, body, prefer } = {}) {
    const headers = { apikey: key, 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (prefer) headers.prefer = prefer;
    return fetch(`${url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  async function grant(type, body, fallbackEmail = '') {
    const r = await call(`/auth/v1/token?grant_type=${type}`, { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.error_description || j.msg || j.message || `HTTP ${r.status}`;
      const signedOut = r.status >= 400 && r.status < 500 && r.status !== 429;
      if (type === 'refresh_token' && signedOut) await save(null);
      throw new AuthError(/invalid login credentials/i.test(msg) ? 'Wrong email or password.' : msg, signedOut);
    }
    const s = {
      email: j.user?.email || fallbackEmail,
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (j.expires_in || 3600) * 1000,
    };
    await save(s);
    return s;
  }

  const signIn = (email, password) => grant('password', { email, password }, email);

  async function token(force = false) {
    const s = await load();
    if (!s?.refresh_token) throw new AuthError('Not signed in.', true);
    if (!force && s.expires_at - Date.now() > 2 * 60 * 1000) return s.access_token;
    // One refresh at a time: Supabase replaces the refresh token each time it is used.
    refreshing ||= grant('refresh_token', { refresh_token: s.refresh_token }, s.email)
      .finally(() => { refreshing = null; });
    return (await refreshing).access_token;
  }

  // Database call through Supabase's REST API. Returns parsed JSON for reads.
  async function rest(method, path, body, prefer) {
    let r = await call(`/rest/v1/${path}`, { method, token: await token(), body, prefer });
    if (r.status === 401) r = await call(`/rest/v1/${path}`, { method, token: await token(true), body, prefer });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.message || `HTTP ${r.status}`);
    }
    return method === 'GET' ? r.json() : null;
  }

  async function signOut() {
    const s = await load();
    if (s?.access_token) await call('/auth/v1/logout?scope=local', { method: 'POST', token: s.access_token }).catch(() => {});
    await save(null);
  }

  return { signIn, signOut, rest, session: load };
}
