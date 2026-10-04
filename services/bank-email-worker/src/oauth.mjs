import { createHash, randomBytes } from 'node:crypto';
import { open, seal } from './crypto.mjs';

export function hashState(state) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(state)) throw new TypeError('INVALID_STATE');
  return createHash('sha256').update(state).digest('hex');
}

export async function beginOAuth({ connectionId, userJwt, config, key, rpc }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(connectionId ?? '') ||
      typeof userJwt !== 'string' || !userJwt) throw new TypeError('INVALID_OAUTH_START');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const stateHash = hashState(state);
  const encryptedVerifier = seal(verifier, key, `pkce:${stateHash}`);
  await rpc('bank_email_oauth_begin_v1', {
    p_connection_id: connectionId,
    p_state_hash: stateHash,
    p_verifier_encrypted: encryptedVerifier,
  }, userJwt);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', config.googleRedirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString() };
}

export async function completeOAuth({ state, code, config, key, rpc, google }) {
  if (typeof code !== 'string' || !code || code.length > 4096) throw new TypeError('INVALID_CODE');
  const stateHash = hashState(state);
  const consumed = await rpc('oauth_consume', { stateHash });
  const verifier = open(consumed.encryptedVerifier, key, `pkce:${stateHash}`);
  const tokens = await google.exchangeCode(code, verifier);
  if (!tokens.refresh_token || !tokens.access_token) throw new Error('REFRESH_TOKEN_REQUIRED');
  const profile = await google.profile(tokens.access_token);
  const email = profile.emailAddress?.toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) throw new Error('INVALID_GOOGLE_PROFILE');
  const watch = await google.watch(tokens.access_token, config.googlePubsubTopic);
  if (!/^\d+$/u.test(watch.historyId ?? '') || !/^\d+$/u.test(watch.expiration ?? '')) {
    throw new Error('INVALID_WATCH');
  }
  return rpc('oauth_complete', {
    stateHash, email,
    encryptedRefreshToken: seal(tokens.refresh_token, key, `refresh:${consumed.connectionId}`),
    historyId: watch.historyId,
    watchExpiresAt: new Date(Number(watch.expiration)).toISOString(),
  });
}
