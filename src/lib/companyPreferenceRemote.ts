import { supabase } from '@/integrations/supabase/client';
import { COMPANY_PREFERENCE_KEY, readLocalCompany, writeLocalCompany } from '@/lib/companyPreference';

export async function readServerCompany(userId: string): Promise<string | null> {
  const token = await companySessionToken(userId);
  const { data, error } = await supabase.from('profiles').select('ui_preferences').eq('id', userId).single().setHeader('Authorization', `Bearer ${token}`);
  if (error) throw error;
  if (!data) throw new Error('Chưa đọc được lựa chọn công ty.');
  const preferences = data.ui_preferences;
  if (preferences === null) return null;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) throw new Error('Chưa đọc được lựa chọn công ty.');
  const id = preferences[COMPANY_PREFERENCE_KEY];
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string') throw new Error('Chưa đọc được lựa chọn công ty.');
  return id;
}
// Serial per-account writes survive provider remounts; a later explicit switch is always last.
const saves = new Map<string, Promise<void>>();
export function saveServerCompany(userId: string, id: string): Promise<void> {
  const previous = saves.get(userId) ?? Promise.resolve();
  const next = previous.catch(() => {
    // The previous caller receives its rejection; it must not block the newer explicit choice.
  }).then(async () => {
    const token = await companySessionToken(userId);
    const { data, error } = await supabase.rpc('set_my_ui_preference', { p_key: COMPANY_PREFERENCE_KEY, p_value: id }).setHeader('Authorization', `Bearer ${token}`);
    if (error) throw error;
    if (!data || typeof data !== 'object' || Array.isArray(data) || data[COMPANY_PREFERENCE_KEY] !== id) throw new Error('Chưa xác nhận được lựa chọn công ty đã lưu.');
  });
  saves.set(userId, next);
  const cleanup = () => { if (saves.get(userId) === next) saves.delete(userId); };
  void next.then(cleanup, cleanup);
  return next;
}

/** Pin Authorization so an auth switch between getSession and fetch cannot write another profile. */
export async function companySessionToken(userId: string): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session || session.user.id !== userId) throw new Error('Phiên đăng nhập đã thay đổi.');
  let subject: unknown;
  try {
    const encoded = session.access_token.split('.').at(1);
    if (!encoded) throw new Error('missing JWT');
    subject = (JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub;
  } catch { throw new Error('Chưa xác nhận được phiên đăng nhập.'); }
  if (subject !== userId) throw new Error('Phiên đăng nhập đã thay đổi.');
  return session.access_token;
}

export interface PreferenceResult { owner: string | null; id: string | null; loaded: boolean; error: string | null; pending: boolean }
interface PreferenceCallbacks { isCurrent: () => boolean; apply: (value: PreferenceResult) => void }

/** One auth lifetime; stale requests may finish but cannot replace newer account/selection state. */
export class CompanyPreferenceSession {
  private revision = 0;
  private state: PreferenceResult;
  private saveStarted: string | null = null;
  constructor(private readonly userId: string, private readonly callbacks: PreferenceCallbacks) {
    this.state = { owner: userId, id: null, loaded: false, error: null, pending: false };
  }
  dispose(): void { this.revision += 1; }
  private current(version: number): boolean { return this.revision === version && this.callbacks.isCurrent(); }
  private apply(state: PreferenceResult): void { this.state = state; this.callbacks.apply(state); }
  async load(): Promise<void> {
    const version = ++this.revision;
    this.saveStarted = null;
    const local = readLocalCompany(this.userId);
    this.apply({ owner: this.userId, id: local.id, loaded: false, error: null, pending: local.pending });
    try {
      const serverId = await readServerCompany(this.userId);
      if (!this.current(version)) return;
      const id = local.pending ? local.id : serverId ?? local.id;
      if (id) writeLocalCompany(this.userId, id, local.pending);
      this.apply({ owner: this.userId, id, loaded: true, error: null, pending: local.pending });
    } catch {
      if (!this.current(version)) return;
      this.apply({ owner: this.userId, id: local.id, loaded: true, pending: local.pending, error: 'Chưa tải được lựa chọn công ty đã lưu. Thử lại để đồng bộ.' });
    }
  }
  ensure(selectedId: string): void {
    if (this.state.loaded && !this.state.error && (this.state.pending || this.state.id !== selectedId) && this.saveStarted !== selectedId) this.select(selectedId);
  }
  select(id: string): void {
    const version = ++this.revision;
    this.saveStarted = id;
    writeLocalCompany(this.userId, id, true);
    this.apply({ owner: this.userId, id, loaded: true, error: null, pending: true });
    void saveServerCompany(this.userId, id).then(() => {
      if (!this.current(version)) return;
      writeLocalCompany(this.userId, id, false);
      this.apply({ owner: this.userId, id, loaded: true, error: null, pending: false });
    }).catch(() => {
      if (!this.current(version)) return;
      this.apply({ owner: this.userId, id, loaded: true, pending: true, error: 'Chưa lưu được lựa chọn công ty lên tài khoản. Lựa chọn trên thiết bị vẫn được giữ; hãy thử lại.' });
    });
  }
  retry(selectedId: string | null): void {
    if (selectedId && this.state.pending) this.select(selectedId);
    else void this.load();
  }
}
