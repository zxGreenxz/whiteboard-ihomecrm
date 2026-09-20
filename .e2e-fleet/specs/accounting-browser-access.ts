import type { Page } from '@playwright/test';

const DEMO_ORG_ID = 'dddd0000-0000-4000-8000-000000000001';

/** Install before login. Readback must use the browser's user JWT, not the PAT. */
export function trackAccountingBrowserAccess(page: Page, projectRef: string, actorId: string) {
  const origin = `https://${projectRef}.supabase.co`;
  let session: { apikey: string; Authorization: string } | undefined;
  page.on('request', request => {
    try {
      const url = new URL(request.url());
      if (url.origin !== origin || !url.pathname.startsWith('/rest/v1/')) return;
      const headers = request.headers();
      const bearer = headers.authorization;
      if (!headers.apikey || !bearer?.startsWith('Bearer ')) return;
      const claims = JSON.parse(Buffer.from(bearer.slice(7).split('.')[1], 'base64url').toString());
      if (claims.sub === actorId) session = { apikey: headers.apikey, Authorization: bearer };
    } catch {
      // Unauthenticated requests do not establish the DEMO session.
    }
  });

  return async (accountId: string): Promise<void> => {
    if (!session) throw new Error('Không xác minh được phiên DEMO của browser cho sổ TT.');
    const query = new URLSearchParams({
      id: `eq.${accountId}`,
      select: 'id,organization_id,is_virtual,deleted_at',
    });
    const response = await fetch(`${origin}/rest/v1/accounts?${query}`, {
      // Match supabase-js: this project exposes multiple PostgREST schemas.
      headers: { ...session, 'Accept-Profile': 'public' },
    });
    if (!response.ok) throw new Error(`Kiểm quyền đọc sổ TT qua RLS thất bại: HTTP ${response.status}`);
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== accountId
      || rows[0]?.organization_id !== DEMO_ORG_ID || rows[0]?.is_virtual !== false
      || rows[0]?.deleted_at !== null) {
      throw new Error('Tài khoản DEMO không đọc được sổ TT thật, còn hoạt động, của fixture.');
    }
  };
}
