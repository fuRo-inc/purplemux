import { NextRequest, NextResponse } from 'next/server';
import {
  verifySessionToken,
  signSessionToken,
  buildCookieHeader,
  SESSION_COOKIE,
  MAX_AGE,
} from '@/lib/auth';
import { verifyTokenValue } from '@/lib/cli-token';

export const proxy = async (request: NextRequest) => {
  // The private MCP bridge reaches the same runtime that serves the browser.
  // No browser cookie or general-purpose CLI token is accepted for this route.
  if (request.nextUrl.pathname === '/api/mcp-internal') {
    const expected = process.env.__PMUX_MCP_INTERNAL_TOKEN;
    const presented = request.headers.get('x-pmux-mcp-internal');
    return expected && presented === expected
      ? NextResponse.next()
      : NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const cliToken = request.headers.get('x-pmux-token');
  if (cliToken && verifyTokenValue(cliToken)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const payload = token ? await verifySessionToken(token) : null;
  if (!payload) {
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const response = NextResponse.next();

  const exp = typeof payload.exp === 'number' ? payload.exp : 0;
  const remaining = exp - Math.floor(Date.now() / 1000);
  if (remaining > 0 && remaining < MAX_AGE / 2) {
    const secure = request.nextUrl.protocol === 'https:';
    const fresh = await signSessionToken();
    response.headers.set('Set-Cookie', buildCookieHeader(fresh, secure));
  }

  return response;
};

export const config = {
  matcher: [
    '/((?!login|api/auth|api/install|api/cli/|api/status/hook|api/health|api/manifest|_next|favicon\\.ico|fonts|.*\\.(?:svg|png|ico|jpg|jpeg|webp|webmanifest|ttf|woff|woff2)).*)',
  ],
};
