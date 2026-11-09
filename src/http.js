export class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (msg = 'Не найдено') => new HttpError(404, msg);
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const str = (v, max) => String(v ?? '').trim().slice(0, max);
