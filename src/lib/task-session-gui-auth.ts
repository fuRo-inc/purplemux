import type { NextApiRequest } from 'next';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, verifySessionToken } from '@/lib/auth';
import { TaskSessionError } from '@/lib/task-session-store';

export const taskSessionCsrf = (sessionToken: string) => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new TaskSessionError('Authentication unavailable', 503);
  return createHmac('sha256', secret).update('task-session-gui:' + sessionToken).digest('hex');
};

/** Cookie session only: CLI tokens and MCP bearer tokens cannot make GUI decisions. */
export const authenticateTaskSessionGui = async (req: NextApiRequest): Promise<string> => {
  const token = req.cookies[SESSION_COOKIE];
  if (!process.env.NEXTAUTH_SECRET || !token || (await verifySessionToken(token))?.sub !== 'user') {
    throw new TaskSessionError('Unauthorized', 401);
  }
  const csrf = taskSessionCsrf(token);
  if (req.method !== 'GET') {
    const supplied = req.headers['x-task-session-csrf'];
    const origin = req.headers.origin;
    const proto = req.headers['x-forwarded-proto'] ?? (('encrypted' in req.socket && req.socket.encrypted) ? 'https' : 'http');
    const expected = `${proto}://${req.headers.host}`;
    // Strict Origin + session-bound CSRF token. Forwarded protocol is set by the trusted ingress.
    if (typeof origin !== 'string' || origin !== expected ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') ||
        typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(supplied))) {
      throw new TaskSessionError('Forbidden', 403);
    }
    if (!req.headers['content-type']?.startsWith('application/json')) {
      throw new TaskSessionError('JSON required', 415);
    }
  }
  return csrf;
};
