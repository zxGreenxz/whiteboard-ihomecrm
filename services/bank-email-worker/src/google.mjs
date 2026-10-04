const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const MAX_JSON_BYTES = 1024 * 1024;

export class GoogleApiError extends Error {
  constructor(status, code = 'GOOGLE_API_ERROR') {
    super(code);
    this.name = 'GoogleApiError';
    this.status = status;
    this.code = code;
  }
}

async function boundedJson(response) {
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new GoogleApiError(502, 'GOOGLE_RESPONSE_LIMIT');
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return text ? JSON.parse(text) : {}; }
  catch { throw new GoogleApiError(502, 'GOOGLE_INVALID_JSON'); }
}

export function createGoogleClient({ clientId, clientSecret, redirectUri }, fetchImpl = fetch) {
  async function request(url, init = {}) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const body = await boundedJson(response);
    if (!response.ok) {
      const code = typeof body.error === 'string' && /^[a-z_]{1,60}$/u.test(body.error) ? body.error : 'GOOGLE_API_ERROR';
      throw new GoogleApiError(response.status, code);
    }
    return body;
  }
  function auth(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken) throw new TypeError('Missing access token');
    return { Authorization: `Bearer ${accessToken}` };
  }
  function idSegment(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new TypeError('Invalid Gmail ID');
    return value;
  }
  return {
    exchangeCode(code, verifier) {
      return request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, code_verifier: verifier, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: 'authorization_code' }) });
    },
    refreshToken(refreshToken) {
      return request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
          grant_type: 'refresh_token' }) });
    },
    async revoke(refreshToken) {
      try {
        await request(REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refreshToken }) });
      } catch (error) {
        if (error.status !== 400 || !['invalid_token', 'invalid_grant'].includes(error.code)) throw error;
      }
    },
    profile(accessToken) {
      return request(`${GMAIL}/profile`, { headers: auth(accessToken) });
    },
    watch(accessToken, topicName) {
      if (!/^projects\/[A-Za-z0-9_.~-]+\/topics\/[A-Za-z0-9_.~-]+$/u.test(topicName ?? '')) throw new TypeError('Invalid Pub/Sub topic');
      return request(`${GMAIL}/watch`, { method: 'POST', headers: { ...auth(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ topicName }) });
    },
    history(accessToken, startHistoryId, pageToken) {
      if (!/^\d+$/u.test(startHistoryId ?? '')) throw new TypeError('Invalid history cursor');
      const url = new URL(`${GMAIL}/history`);
      url.searchParams.set('startHistoryId', startHistoryId);
      url.searchParams.set('historyTypes', 'messageAdded');
      url.searchParams.set('maxResults', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      return request(url, { headers: auth(accessToken) });
    },
    listMessages(accessToken, pageToken) {
      const url = new URL(`${GMAIL}/messages`);
      url.searchParams.set('q', 'from:mailalert@acb.com.vn');
      url.searchParams.set('maxResults', '25');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      return request(url, { headers: auth(accessToken) });
    },
    getMessage(accessToken, id) {
      return request(`${GMAIL}/messages/${idSegment(id)}?format=raw`, { headers: auth(accessToken) });
    },
    getMessageMetadata(accessToken, id) {
      return request(`${GMAIL}/messages/${idSegment(id)}?format=metadata&metadataHeaders=From`, { headers: auth(accessToken) });
    },
  };
}
