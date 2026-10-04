export class RpcError extends Error {
  constructor(status, code = 'RPC_FAILED') {
    super(code);
    this.name = 'RpcError';
    this.status = status;
    this.code = code;
  }
}

export function createRpcClient({ supabaseUrl, anonKey, serviceKey }, fetchImpl = fetch) {
  const base = new URL(supabaseUrl);
  if (base.protocol !== 'https:') throw new TypeError('SUPABASE_URL must use HTTPS');
  return async function rpc(operation, payload, userJwt) {
    const isUserOperation = operation === 'bank_email_oauth_begin_v1';
    if (isUserOperation && !userJwt) throw new TypeError('User JWT required');
    if (!isUserOperation && userJwt) throw new TypeError('Unexpected user JWT');
    const route = isUserOperation ? operation : 'bank_email_worker_v1';
    const body = isUserOperation ? payload : { p_operation: operation, p_payload: payload };
    const key = isUserOperation ? anonKey : serviceKey;
    const response = await fetchImpl(new URL(`/rest/v1/rpc/${route}`, base), {
      method: 'POST', headers: { apikey: key, Authorization: `Bearer ${isUserOperation ? userJwt : serviceKey}`,
        'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const raw = await response.text();
    if (raw.length > 512 * 1024) throw new RpcError(502, 'RPC_RESPONSE_LIMIT');
    let result;
    try { result = raw ? JSON.parse(raw) : null; }
    catch { throw new RpcError(502, 'RPC_INVALID_JSON'); }
    if (!response.ok) {
      const code = typeof result?.code === 'string' && /^[A-Za-z0-9_]{1,80}$/u.test(result.code) ? result.code : 'RPC_FAILED';
      throw new RpcError(response.status, code);
    }
    return result;
  };
}
