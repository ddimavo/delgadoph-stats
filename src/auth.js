import crypto from 'node:crypto';

const TTL = 30 * 24 * 3600_000;
const sign = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');

export function makeSession(secret, nick, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ n: nick, e: now + TTL })).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

export function readSession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const good = sign(secret, body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const { n, e } = JSON.parse(Buffer.from(body, 'base64url').toString());
    return e > now ? n : null;
  } catch { return null; }
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Простой ограничитель попыток входа по IP: max за окно. */
export function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    return arr.length <= max;
  };
}
