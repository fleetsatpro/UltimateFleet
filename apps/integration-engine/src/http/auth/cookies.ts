import type { Request, Response } from 'express';

/**
 * Minimal cookie handling for the dashboard session, without pulling in cookie-parser.
 *
 * The session cookie carries only an opaque session id and is HttpOnly (so page scripts cannot
 * read it, blunting XSS token theft), SameSite=Lax (so it is not sent on cross-site POSTs,
 * blunting CSRF), and Secure in production (never sent over plaintext). Path=/ so it covers the
 * whole dashboard surface.
 */
export const SESSION_COOKIE = 'ds_session';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(
  res: Response,
  sessionId: string,
  maxAgeSeconds: number,
  secure: boolean,
): void {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res: Response, secure: boolean): void {
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}
