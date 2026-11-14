// Employee logins can be a phone number instead of an email (version 1.9.1). No text messages are
// sent (Supabase would need a paid texting service): the owner gives them a password and resets it
// with Employee logins → New password. Supabase logins need an email, so a phone number becomes a
// made-up address that can never receive mail: the full number with the country code (a US number's
// leading 1 added), @phone.invalid ("invalid" is reserved for addresses that don't exist).
export const PHONE_DOMAIN = 'phone.invalid';

// What someone typed in the "phone number or email" box -> the login's email, or '' when it's neither.
export function loginEmail(text) {
  const s = String(text || '').trim().toLowerCase();
  if (s.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
  if (!/^\+?[\d\s().-]+$/.test(s)) return '';
  let d = s.replace(/\D/g, '');
  if (d.length === 10) d = `1${d}`; // a US number typed without the 1
  if (d.length < 11 || d.length > 15) return '';
  return `${d}@${PHONE_DOMAIN}`;
}

// A login as people know it: the phone number back for phone logins, otherwise the email.
export function loginLabel(email) {
  const m = String(email || '').match(/^(\d+)@phone\.invalid$/);
  if (!m) return email || '';
  const d = m[1];
  return d.length === 11 && d[0] === '1' ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : `+${d}`;
}
