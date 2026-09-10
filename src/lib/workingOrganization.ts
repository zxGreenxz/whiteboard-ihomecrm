// This is request context, never an authorization decision. PostgreSQL validates
// active membership and the original operation's permissions on every request.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const WORKING_ORGANIZATION_HEADER = 'x-ihomecrm-organization-id';
let activeUserId: string | null = null;
let activeOrganizationId: string | null = null;
let pendingRequests = 0;

export const organizationStorageKey = (userId: string) => `ihomecrm.selectedOrganizationId:${userId}`;

export function readWorkingOrganization(userId: string | null): string | null {
  if (!userId) return null;
  try {
    if (typeof localStorage === 'undefined') return null;
    const value = localStorage.getItem(organizationStorageKey(userId));
    return value && UUID.test(value) ? value : null;
  } catch (error) {
    // Browser privacy settings may disable persistence. Require a fresh choice
    // in memory; unexpected failures must remain visible.
    if (error instanceof DOMException && ['SecurityError', 'QuotaExceededError'].includes(error.name)) return null;
    throw error;
  }
}

export function syncWorkingOrganizationUser(userId: string | null): void {
  if (userId === activeUserId) return;
  activeUserId = null;
  activeOrganizationId = null;
  const organizationId = readWorkingOrganization(userId);
  activeUserId = userId;
  activeOrganizationId = organizationId;
}

export function setWorkingOrganization(userId: string, organizationId: string | null): void {
  activeUserId = userId;
  activeOrganizationId = organizationId && UUID.test(organizationId) ? organizationId : null;
  try {
    if (typeof localStorage === 'undefined') return;
    if (activeOrganizationId) localStorage.setItem(organizationStorageKey(userId), activeOrganizationId);
    else localStorage.removeItem(organizationStorageKey(userId));
  } catch (error) {
    // Disabled/full storage must not prevent this session's explicit choice.
    if (!(error instanceof DOMException) || !['SecurityError', 'QuotaExceededError'].includes(error.name)) throw error;
  }
}

export const getWorkingOrganization = (): string | null => activeOrganizationId;
export const hasPendingOrganizationRequests = (): boolean => pendingRequests > 0;

export function requireWorkingOrganization(): string {
  if (!activeOrganizationId) throw new Error('Hãy chọn công ty làm việc trong Tài khoản trước khi thực hiện thao tác này.');
  return activeOrganizationId;
}

export function createOrganizationFetch(supabaseUrl: string, fetcher: typeof fetch = (input, init) => fetch(input, init)): typeof fetch {
  const origin = new URL(supabaseUrl).origin;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) return fetcher(input, init);
    if (url.pathname.startsWith('/storage/v1/object/') && ['POST', 'PUT', 'DELETE'].includes(init?.method ?? (input instanceof Request ? input.method : 'GET'))) {
      pendingRequests += 1;
      try { return await fetcher(input, init); }
      finally { pendingRequests -= 1; }
    }
    if (!url.pathname.startsWith('/rest/v1/')) return fetcher(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.delete(WORKING_ORGANIZATION_HEADER);
    if (activeOrganizationId) headers.set(WORKING_ORGANIZATION_HEADER, activeOrganizationId);
    // Capture the choice before dispatch; switching cannot relabel an in-flight request.
    pendingRequests += 1;
    try { return await fetcher(input, { ...init, headers }); }
    finally { pendingRequests -= 1; }
  };
}
