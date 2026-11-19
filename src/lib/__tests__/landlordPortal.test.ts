// Link tên miền cho chủ nhà (24/10/2026): tên miền ⇒ tên link, PIN dễ đoán, cất phiên trên máy (trình duyệt chặn
// bộ nhớ thì không vỡ trang).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWeakPin, landlordPortalSlugFromHost, landlordPortalUrl, portalLoginSchema, readPortalSession, writePortalSession,
} from '@/lib/landlordPortal';

const PHIEN = 'a'.repeat(43);

describe('landlordPortal', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('tên miền riêng ⇒ tên link cố định; tên miền khác ⇒ null', () => {
    expect(landlordPortalSlugFromHost('cgiang.chillhome.io.vn')).toBe('cgiang');
    expect(landlordPortalSlugFromHost('AGIANG.chillhome.io.vn.')).toBe('agiang');
    for (const h of ['chillhome.io.vn', 'ptcrm.vercel.app', 'localhost', 'xgiang.chillhome.io.vn', 'cgiang.chillhome.io.vn.evil.com', '']) {
      expect(landlordPortalSlugFromHost(h), h).toBeNull();
    }
    expect(landlordPortalUrl('agiang')).toBe('https://agiang.chillhome.io.vn');
    expect(landlordPortalUrl('moi')).toBe('https://chillhome.io.vn/cn/moi');
  });

  it('PIN dễ đoán: lặp một số, dãy liên tiếp tăng / giảm', () => {
    for (const p of ['000000', '777777', '012345', '123456', '456789', '987654', '543210']) expect(isWeakPin(p), p).toBe(true);
    for (const p of ['482916', '135790', '120345', '100000']) expect(isWeakPin(p), p).toBe(false);
  });

  it('gói đăng nhập: phân theo status; phiên sai dạng ⇒ lỗi', () => {
    expect(portalLoginSchema.parse({ status: 'OK', session: PHIEN, viewer: 'A', expires_at: 'x' }).status).toBe('OK');
    expect(portalLoginSchema.parse({ status: 'LOCKED', retry_after_seconds: 90 })).toEqual({ status: 'LOCKED', retry_after_seconds: 90 });
    expect(() => portalLoginSchema.parse({ status: 'OK', session: 'ngan', viewer: 'A', expires_at: 'x' })).toThrow();
  });

  it('cất / đọc / xoá phiên theo link; bộ nhớ bị chặn ⇒ null, không ném', () => {
    const kho = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kho.get(k) ?? null,
      setItem: (k: string, v: string) => { kho.set(k, v); },
      removeItem: (k: string) => { kho.delete(k); },
    });
    writePortalSession('agiang', PHIEN);
    expect(readPortalSession('agiang')).toBe(PHIEN);
    expect(readPortalSession('cgiang')).toBeNull();
    kho.set('landlord-portal-session:cgiang', 'rac');
    expect(readPortalSession('cgiang')).toBeNull();
    writePortalSession('agiang', null);
    expect(readPortalSession('agiang')).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('chặn'); },
      setItem: () => { throw new Error('chặn'); },
      removeItem: () => { throw new Error('chặn'); },
    });
    expect(readPortalSession('agiang')).toBeNull();
    expect(() => writePortalSession('agiang', PHIEN)).not.toThrow();
  });
});
