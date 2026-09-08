// Only the server receives GOONG_API_KEY. This endpoint derives a preview;
// it neither reads customer records nor writes any customer fields.
const text = (value, limit = 600) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
// Best-effort per warm server instance; not an account-wide billing quota.
// Only user IDs and counters are retained, never customer addresses or JWTs.
const usage = new Map();
function allowLookup(userId) {
  const now = Date.now();
  for (const [id, window] of usage) if (window.until <= now) usage.delete(id);
  let window = usage.get(userId);
  if (!window) {
    if (usage.size >= 2000) return false;
    window = { count: 0, until: now + 60000 };
    usage.set(userId, window);
  }
  return ++window.count <= 30;
}

function candidatesFrom(results) {
  const seen = new Set();
  const candidates = [];
  for (const item of results.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const province = text(item.compound?.province, 150);
    const ward = text(item.compound?.commune || item.compound?.ward, 150);
    const formattedAddress = text(item.formatted_address);
    if (!province || !ward || !formattedAddress) continue;
    const id = text(item.place_id) || formattedAddress;
    if (seen.has(id)) continue;
    seen.add(id);
    const old = item.deprecated_compound;
    candidates.push({ id, formattedAddress, province, ward,
      oldAddress: [old?.commune || old?.ward, old?.district, old?.province]
        .map(value => text(value, 150)).filter(Boolean).join(', '),
    });
    if (candidates.length === 5) break;
  }
  return candidates;
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
    if (body.length > 4096) return res.status(400).json({ code: 'INVALID_ADDRESS' });
    try { body = JSON.parse(body); } catch {
      return res.status(400).json({ code: 'INVALID_ADDRESS' }); // Malformed input is not a provider failure.
    }
  }
  if (typeof body?.address !== 'string' || !body.address.trim() || body.address.length > 600) {
    return res.status(400).json({ code: 'INVALID_ADDRESS' });
  }
  const address = body.address.trim().replace(/\s+/g, ' ');
  const key = process.env.GOONG_API_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const publicKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key || !supabaseUrl || !publicKey) {
    return res.status(503).json({ code: 'NOT_CONFIGURED' });
  }
  // Validate the JWT with this app's GoTrue server, not merely by decoding it.
  try {
    const auth = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
      headers: { authorization, apikey: publicKey }, signal: AbortSignal.timeout(4000),
    });
    const user = auth.ok ? await auth.json() : null;
    if (typeof user?.id !== 'string' || !user.id || user.is_anonymous === true) {
      return res.status(401).json({ code: 'UNAUTHORIZED' });
    }
    if (!allowLookup(user.id)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ code: 'RATE_LIMITED' });
    }
  } catch {
    return res.status(503).json({ code: 'AUTH_UNAVAILABLE' }); // Do not expose upstream URLs or JWTs in errors.
  }
  const url = new URL('https://rsapi.goong.io/v2/geocode');
  url.searchParams.set('address', address);
  url.searchParams.set('api_key', key);
  url.searchParams.set('has_deprecated_administrative_unit', 'true');
  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!upstream.ok) return res.status(502).json({ code: 'PROVIDER_UNAVAILABLE' });
    const payload = await upstream.json();
    if (payload?.status === 'ZERO_RESULTS') {
      return res.status(200).json({ source: 'goong-v2', candidates: [] });
    }
    if (payload?.status !== 'OK' || !Array.isArray(payload.results)) {
      return res.status(502).json({ code: 'PROVIDER_UNAVAILABLE' });
    }
    return res.status(200).json({ source: 'goong-v2', candidates: candidatesFrom(payload.results) });
  } catch {
    // No V1 fallback: legacy results must never be presented as new administrative units.
    return res.status(502).json({ code: 'PROVIDER_UNAVAILABLE' });
  }
}
