export const COMPANY_PREFERENCE_KEY = 'selectedOrganizationId';
export const ACTIVE_COMPANY_KEY = 'ihomecrm.selectedOrganizationId';
const OWNER_KEY = 'ihomecrm.selectedOrganizationOwner';
const accountKey = (userId: string) => `${ACTIVE_COMPANY_KEY}:${userId}`;
export interface CompanyPreference { id: string | null; pending: boolean }

export function readLocalCompany(userId: string): CompanyPreference {
  try {
    const saved = localStorage.getItem(accountKey(userId));
    if (saved) {
      const value: unknown = JSON.parse(saved);
      if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
        return { id: value.id, pending: 'pending' in value && value.pending === true };
      }
    }
    // Migrate the old browser preference once; its owner marker fences later accounts.
    const owner = localStorage.getItem(OWNER_KEY);
    const id = !owner || owner === userId ? localStorage.getItem(ACTIVE_COMPANY_KEY) : null;
    if (id) {
      localStorage.setItem(OWNER_KEY, userId);
      localStorage.setItem(accountKey(userId), JSON.stringify({ id, pending: true }));
    }
    return { id, pending: !!id };
  } catch { return { id: null, pending: false }; }
}
export function writeLocalCompany(userId: string, id: string, pending: boolean): void {
  try { localStorage.setItem(accountKey(userId), JSON.stringify({ id, pending })); } catch { /* server remains authoritative */ }
}
export function syncActiveCompany(userId: string | null, id: string | null): void {
  try {
    if (id && userId) {
      localStorage.setItem(OWNER_KEY, userId);
      localStorage.setItem(ACTIVE_COMPANY_KEY, id);
    } else localStorage.removeItem(ACTIVE_COMPANY_KEY);
  } catch { /* scope consumers still receive context */ }
}

/** Loaded with the remote preference service so entry keeps only synchronous scope helpers. */
export async function companySessionToken(userId: string): Promise<string> {
  return (await import('@/lib/companyPreferenceRemote')).companySessionToken(userId);
}
