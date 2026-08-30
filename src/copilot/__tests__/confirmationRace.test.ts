import { beforeEach, describe, expect, it } from 'vitest';
import {
  datNguCanhXacNhan,
  datXacNhanDangCho,
  layNguCanhXacNhan,
  layXacNhanDangCho,
  tieuXacNhan,
  xoaXacNhanDangCho,
} from '../confirmationStore';
import { makeConfirmationIntentKey } from '../tools/writeTools';
import { thucThiXacNhan } from '../tools/writeTools';

const proposal = {
  nonce: 'a'.repeat(64),
  canonical: { organization_id: 'org-a', amount: 100 },
  preview: { so_tien: 100 },
};

describe('confirmation race boundaries', () => {
  beforeEach(() => {
    xoaXacNhanDangCho();
    datNguCanhXacNhan(null);
  });

  it('does not expose a proposal to a different organization or thread', () => {
    datNguCanhXacNhan({ organizationId: 'org-a', threadId: 'thread-a', generation: 1 });
    datXacNhanDangCho(proposal);

    expect(layXacNhanDangCho(Date.now(), undefined, { organizationId: 'org-a', threadId: 'thread-a' })).toBeTruthy();
    expect(layXacNhanDangCho(Date.now(), undefined, { organizationId: 'org-b', threadId: 'thread-a' })).toBeNull();
    expect(layXacNhanDangCho(Date.now(), undefined, { organizationId: 'org-a', threadId: 'thread-b' })).toBeNull();
  });

  it('clears the pending proposal when the active chat scope changes', () => {
    datNguCanhXacNhan({ organizationId: 'org-a', threadId: 'thread-a', generation: 1 });
    datXacNhanDangCho(proposal);

    datNguCanhXacNhan({ organizationId: 'org-a', threadId: 'thread-b', generation: 2 });
    expect(layXacNhanDangCho()).toBeNull();
    expect(layNguCanhXacNhan()).toEqual({ organizationId: 'org-a', threadId: 'thread-b', generation: 2 });
  });

  it('does not consume a proposal when a stale scope attempts to take it', () => {
    datNguCanhXacNhan({ organizationId: 'org-a', threadId: 'thread-a', generation: 1 });
    datXacNhanDangCho(proposal);

    expect(tieuXacNhan(Date.now(), undefined, { organizationId: 'org-b', threadId: 'thread-a' })).toBeNull();
    expect(layXacNhanDangCho()).toBeTruthy();
  });

  it('separates identical payloads across conversation threads', () => {
    const a = makeConfirmationIntentKey('org-a', { amount: 100 }, 'thread-a');
    const b = makeConfirmationIntentKey('org-a', { amount: 100 }, 'thread-b');
    expect(a).not.toBe(b);
  });

  it('rejects execution when the active scope changed after rendering', async () => {
    datNguCanhXacNhan({ organizationId: 'org-b', threadId: 'thread-b', generation: 2 });
    await expect(
      thucThiXacNhan(proposal.nonce, proposal.canonical, {
        organizationId: 'org-a',
        threadId: 'thread-a',
        generation: 1,
      }),
    ).rejects.toThrow(/confirmation_scope_mismatch/);
  });
});
