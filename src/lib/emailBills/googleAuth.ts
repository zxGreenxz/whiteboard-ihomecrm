import type { GmailSession } from './types';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCRIPT_URL = 'https://accounts.google.com/gsi/client';
interface TokenResponse { access_token?: string; expires_in?: number | string; scope?: string; error?: string }
interface GoogleOAuth {
  initTokenClient(config: { client_id: string; scope: string; include_granted_scopes: boolean; callback: (response: TokenResponse) => void; error_callback: (error: { type?: string }) => void }): { requestAccessToken(options: { prompt: string }): void };
  hasGrantedAllScopes(response: TokenResponse, ...scopes: string[]): boolean;
}
export class GoogleAuthError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'GoogleAuthError'; }
}
function oauth(): GoogleOAuth | undefined {
  const globalGoogle = (globalThis as typeof globalThis & { google?: { accounts?: { oauth2?: GoogleOAuth } } }).google;
  return globalGoogle?.accounts?.oauth2;
}
let loading: Promise<void> | null = null;

// UI prepares this before the authorize button becomes enabled. No token or
// Gmail request is made here; authorization must stay inside the later click.
export function loadGoogleAuth(): Promise<void> {
  if (oauth()) return Promise.resolve();
  if (loading) return loading;
  if (typeof document === 'undefined') return Promise.reject(new GoogleAuthError('not_ready', 'Không tải được kết nối Google trong môi trường này.'));
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL; script.async = true; script.defer = true;
    const timer = setTimeout(() => fail(), 20_000);
    const cleanup = () => { clearTimeout(timer); script.onload = null; script.onerror = null; };
    const fail = () => { cleanup(); script.remove(); loading = null; reject(new GoogleAuthError('script_failed', 'Không tải được kết nối Google. Vui lòng thử lại.')); };
    script.onload = () => { if (!oauth()) { fail(); return; } cleanup(); resolve(); };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return loading;
}

// Intentionally not async: requestAccessToken runs synchronously in the click's
// user gesture. Only the callback result is asynchronous.
export function authorizeGmail(clientId: string): Promise<GmailSession> {
  const googleOAuth = oauth();
  if (!clientId.trim()) return Promise.reject(new GoogleAuthError('missing_config', 'Chưa cấu hình kết nối Gmail.'));
  if (!googleOAuth) return Promise.reject(new GoogleAuthError('not_ready', 'Kết nối Google chưa sẵn sàng. Vui lòng thử lại.'));
  return new Promise<GmailSession>((resolve, reject) => {
    let settled = false;
    const fail = (code: string, message: string) => { if (settled) return; settled = true; clearTimeout(timer); reject(new GoogleAuthError(code, message)); };
    const timer = setTimeout(() => fail('timeout', 'Kết nối Gmail quá thời gian. Vui lòng thử lại.'), 120_000);
    try {
      const client = googleOAuth.initTokenClient({
        client_id: clientId.trim(), scope: GMAIL_SCOPE, include_granted_scopes: false,
        callback: (response) => {
          if (settled) return;
          if (response.error) { fail('authorization_failed', 'Google chưa cấp quyền đọc Gmail.'); return; }
          if (!googleOAuth.hasGrantedAllScopes(response, GMAIL_SCOPE)) { fail('missing_scope', 'Bạn cần cấp quyền đọc Gmail để chọn biên nhận.'); return; }
          const seconds = Number(response.expires_in);
          if (!response.access_token || !Number.isFinite(seconds) || seconds <= 0) { fail('invalid_response', 'Google trả về phiên kết nối không hợp lệ.'); return; }
          settled = true; clearTimeout(timer);
          resolve({ accessToken: response.access_token, expiresAt: Date.now() + seconds * 1000 });
        },
        error_callback: (error) => fail(error.type === 'popup_closed' ? 'popup_closed' : error.type === 'popup_failed_to_open' ? 'popup_failed_to_open' : 'authorization_failed', error.type === 'popup_closed' ? 'Bạn đã đóng cửa sổ kết nối Gmail.' : 'Không mở được cửa sổ kết nối Google. Kiểm tra quyền mở cửa sổ bật lên.'),
      });
      client.requestAccessToken({ prompt: 'select_account' });
    } catch { fail('authorization_failed', 'Không kết nối được Google. Vui lòng thử lại.'); }
  });
}
