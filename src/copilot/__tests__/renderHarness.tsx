import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { CopilotAvailabilitySnapshot } from '../featureFlags';
import type { PermissionsMap } from '@/lib/permissions';

// Only I/O boundaries are replaced: real panel, launcher, permission and
// availability guards, cards, markdown and toast rendering remain mounted.
const io = vi.hoisted(() => ({
  user: { id: 'demo-user' } as { id: string } | undefined,
  org: 'dddd0000-0000-4000-8000-000000000001' as string | null,
  perms: undefined as PermissionsMap | undefined,
  entitlement: undefined as { chat_enabled: boolean; ui_control_enabled: boolean } | undefined,
  providers: undefined as { value: string; label: string }[] | undefined,
  availability: null as CopilotAvailabilitySnapshot | null,
  refetch: vi.fn(), latest: vi.fn(), messages: vi.fn(), create: vi.fn(), turn: vi.fn(), save: vi.fn(),
  uiAgent: vi.fn(), entitlementQuery: vi.fn(), permissionQuery: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ data: io.user }) }));
vi.mock('@/hooks/useMyPermissions', () => ({ useMyPermissions: () => { io.permissionQuery(); return { data: io.perms }; } }));
vi.mock('@/hooks/useIsAdmin', () => ({ useIsSuperAdmin: () => ({ data: false }) }));
vi.mock('@/contexts/OrganizationContext', () => ({ useOrganization: () => ({ selectedOrganizationId: io.org }) }));
vi.mock('../useAiProviders', () => ({
  useCopilotEntitlement: () => { io.entitlementQuery(); return { data: io.entitlement }; },
  useAiProviders: () => ({ data: io.providers }),
  useCopilotModel: () => ({ model: 'test:model', setModel: vi.fn(), modelLoiThoi: false }),
}));
vi.mock('../featureFlags', async importOriginal => ({
  ...await importOriginal<typeof import('../featureFlags')>(),
  useCopilotAvailability: () => ({ data: io.availability, refetch: io.refetch }),
}));
vi.mock('../chatEngine', async importOriginal => ({
  ...await importOriginal<typeof import('../chatEngine')>(),
  loadLatestThread: io.latest, loadThreadMessages: io.messages, createThread: io.create,
  runChatTurn: io.turn, saveMessages: io.save,
}));
vi.mock('../createAgent', () => ({ createUiControlAgent: io.uiAgent }));
vi.mock('../memoryClient', async importOriginal => ({
  ...await importOriginal<typeof import('../memoryClient')>(), layGhiNho: async () => [],
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

export function fresh(): CopilotAvailabilitySnapshot {
  return { organizationId: 'dddd0000-0000-4000-8000-000000000001', fetchedAt: Date.now(), revision: 1, states: { 'page:rooms.list': 'enabled' } };
}
export function resetIo() {
  vi.clearAllMocks();
  io.user = { id: 'demo-user' }; io.org = 'dddd0000-0000-4000-8000-000000000001';
  io.perms = { ai_copilot: { view: true, ui_control: true }, rooms: { view: true } };
  io.entitlement = { chat_enabled: true, ui_control_enabled: true };
  io.providers = [{ value: 'test:model', label: 'Test model' }]; io.availability = fresh();
  io.refetch.mockReset().mockResolvedValue({ data: fresh() });
  io.latest.mockReset().mockResolvedValue(null); io.messages.mockReset().mockResolvedValue([]);
  io.create.mockReset().mockResolvedValue({ id: 'thread-demo' }); io.save.mockReset().mockResolvedValue(undefined);
  io.turn.mockReset().mockImplementation(async ({ userText }) => ({ newMessages: [
    { role: 'user', content: userText }, { role: 'assistant', content: 'Có 2 phòng trống: A101, A102.' },
  ], toolEvents: [] }));
  io.uiAgent.mockReset().mockImplementation(() => ({ run: async () => ({ data: 'Đã lọc phòng.' }), dispose() {}, stop: async () => {} }));
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value() {} });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
}
let root: Root | undefined;
export async function mount(node: ReactNode, path = '/apartments') {
  const container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{node}</MemoryRouter>); });
}
export async function unmount() {
  await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren();
}
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`Missing mounted element: ${id}`);
  return found;
}
export async function click(el: HTMLElement) { await act(async () => el.click()); }
export async function send(text = 'Phòng nào đang trống?') {
  const input = byId<HTMLTextAreaElement>('copilot-input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click(byId('copilot-send'));
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

export { io };

export async function eventually(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 10)); }); assertion(); });
}
