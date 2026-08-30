import { beforeEach, describe, expect, it, vi } from 'vitest';

const from = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from, auth: { getUser } },
}));

const { isCurrentChatScope, loadLatestThread, loadThreadMessages, saveMessages } = await import('../chatEngine');

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const USER = '00000000-0000-4000-8000-0000000000ff';

type QueryResult = { data: unknown; error: unknown };

function chain(result: QueryResult, calls: [string, unknown[]][]) {
  const q: Record<string, unknown> = {};
  for (const name of ['select', 'eq', 'is', 'order', 'limit', 'insert']) {
    q[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return q;
    };
  }
  q.maybeSingle = () => Promise.resolve(result);
  q.single = () => Promise.resolve(result);
  q.then = (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

beforeEach(() => {
  from.mockReset();
  getUser.mockReset().mockResolvedValue({ data: { user: { id: USER } } });
});

describe('chat persistence organization boundary', () => {
  it('invalidates stale async results after organization changes', () => {
    expect(isCurrentChatScope(1, 2, ORG_A, ORG_B)).toBe(false);
    expect(isCurrentChatScope(2, 2, ORG_B, ORG_B)).toBe(true);
  });

  it('loads only the latest thread in the selected organization', async () => {
    const calls: [string, unknown[]][] = [];
    from.mockReturnValue(chain({ data: { id: 'thread-a', title: 'A', updated_at: 'now' }, error: null }, calls));

    await expect(loadLatestThread(ORG_A)).resolves.toMatchObject({ id: 'thread-a' });
    expect(calls).toContainEqual(['eq', ['organization_id', ORG_A]]);
  });

  it('does not read messages for a thread whose parent belongs to another organization', async () => {
    const parentCalls: [string, unknown[]][] = [];
    const messageCalls: [string, unknown[]][] = [];
    from
      .mockReturnValueOnce(chain({ data: null, error: null }, parentCalls))
      .mockReturnValueOnce(chain({ data: [], error: null }, messageCalls));

    await expect(loadThreadMessages('thread-b', ORG_A)).resolves.toEqual([]);
    expect(parentCalls).toContainEqual(['eq', ['organization_id', ORG_A]]);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('rejects saving when the parent thread is outside the selected organization', async () => {
    const parentCalls: [string, unknown[]][] = [];
    from.mockReturnValue(chain({ data: null, error: null }, parentCalls));

    await expect(
      saveMessages('thread-b', [{ role: 'user', content: 'secret' }], 'model', ORG_A),
    ).rejects.toThrow(/thread|organization/i);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('keeps the single-organization persistence path working', async () => {
    const parentCalls: [string, unknown[]][] = [];
    const insertCalls: [string, unknown[]][] = [];
    from
      .mockReturnValueOnce(chain({ data: { id: 'thread-a', user_id: USER, organization_id: ORG_A }, error: null }, parentCalls))
      .mockReturnValueOnce(chain({ data: null, error: null }, insertCalls));

    await expect(
      saveMessages('thread-a', [{ role: 'user', content: 'hello' }], 'model', ORG_A),
    ).resolves.toBeUndefined();
    expect(parentCalls).toContainEqual(['eq', ['user_id', USER]]);
    expect(parentCalls).toContainEqual(['eq', ['organization_id', ORG_A]]);
    expect(insertCalls).toContainEqual(['insert', [expect.arrayContaining([
      expect.objectContaining({ organization_id: ORG_A }),
    ])]]);
  });
});
