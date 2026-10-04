// Same-origin bridge keeps Gmail setup inside the application's existing CSP.
// Only the server-configured worker receives the user's short-lived CRM JWT.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function httpsOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && url.pathname === '/' && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ code: 'METHOD_NOT_ALLOWED' });
  }
  const authorization = req.headers?.authorization;
  if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization) || authorization.length > 8192) {
    return res.status(401).json({ code: 'UNAUTHORIZED' });
  }
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > 4096) return res.status(400).json({ code: 'INVALID_REQUEST' });
    try { body = JSON.parse(body); } catch { return res.status(400).json({ code: 'INVALID_REQUEST' }); }
  }
  if (!body || typeof body.connectionId !== 'string' || !UUID.test(body.connectionId)) {
    return res.status(400).json({ code: 'INVALID_REQUEST' });
  }
  const worker = httpsOrigin(process.env.BANK_EMAIL_WORKER_URL);
  const origin = httpsOrigin(process.env.APP_ORIGIN);
  if (!worker || !origin) return res.status(503).json({ code: 'BANK_EMAIL_NOT_CONFIGURED' });
  try {
    const upstream = await fetch(`${worker}/oauth/start`, {
      method: 'POST',
      headers: { Authorization: authorization, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: body.connectionId }),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      const status = [400, 401, 403, 409, 429, 503].includes(upstream.status) ? upstream.status : 502;
      return res.status(status).json({ code: 'BANK_EMAIL_OAUTH_UNAVAILABLE' });
    }
    const payload = await upstream.json();
    if (typeof payload?.url !== 'string' || payload.url.length > 8192) throw new Error('Invalid worker response');
    const destination = new URL(payload.url);
    if (destination.origin !== 'https://accounts.google.com' || destination.pathname !== '/o/oauth2/v2/auth'
      || destination.username || destination.password) throw new Error('Invalid authorization destination');
    return res.status(200).json({ url: destination.toString() });
  } catch {
    // Upstream exceptions can include credentials; never return their bodies or log them.
    return res.status(502).json({ code: 'BANK_EMAIL_OAUTH_UNAVAILABLE' });
  }
}
