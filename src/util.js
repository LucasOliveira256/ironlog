import crypto from 'node:crypto';
export const now = () => Date.now();
export const uuid = () => crypto.randomUUID();
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const b64u = b => Buffer.from(b).toString('base64url');
export const fromB64u = s => new Uint8Array(Buffer.from(s, 'base64url'));
export const HOUR = 3600e3, DAY = 86400e3;
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const bad = (m = 'Requisição inválida') => new HttpError(400, m);
export const denied = (m = 'Não autorizado') => new HttpError(401, m);
export const forbidden = (m = 'Proibido') => new HttpError(403, m);
export const notFound = (m = 'Não encontrado') => new HttpError(404, m);
export const conflict = (m = 'Conflito') => new HttpError(409, m);
