import { describe, it, expect, afterEach } from 'vitest';
import {
  isChunkLoadError,
  extractChunkUrl,
  hasAutoReloadBudget,
  isReloadPending,
} from '../chunkReload';

// Message THẬT lấy từ console prod khi mở /contracts sau deploy (2026-07-01).
const REAL_MIME_ERR =
  "Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of \"text/html\". Strict MIME type checking is enforced for module scripts per HTML spec.";
const REAL_FETCH_ERR =
  'TypeError: Failed to fetch dynamically imported module: https://ptcrm.vercel.app/assets/ContractsPage-Bn7e08OO.js';

describe('isChunkLoadError', () => {
  it('nhận diện lỗi MIME text/html (chunk bị SPA-rewrite nuốt)', () => {
    expect(isChunkLoadError(new Error(REAL_MIME_ERR))).toBe(true);
    expect(isChunkLoadError(REAL_MIME_ERR)).toBe(true);
  });

  it('nhận diện lỗi "Failed to fetch dynamically imported module"', () => {
    expect(isChunkLoadError(new Error(REAL_FETCH_ERR))).toBe(true);
  });

  it('nhận diện biến thể Firefox/Safari', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
  });

  it('nhận diện lỗi preload CSS của Vite + biến thể webpack', () => {
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/InvoicesPage-Ab12.css'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true);
    expect(isChunkLoadError({ name: 'ChunkLoadError', message: 'ChunkLoadError' })).toBe(true);
  });

  it('KHÔNG nhận nhầm lỗi thường (để không nuốt bug thật thành reload)', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('extractChunkUrl', () => {
  it('rút URL .js từ message "Failed to fetch dynamically imported module"', () => {
    expect(extractChunkUrl(new Error(REAL_FETCH_ERR))).toBe(
      'https://ptcrm.vercel.app/assets/ContractsPage-Bn7e08OO.js'
    );
  });

  it('rút được cả .mjs / .cjs', () => {
    expect(
      extractChunkUrl(new Error('Failed to fetch dynamically imported module: https://x.app/assets/a-b.mjs'))
    ).toBe('https://x.app/assets/a-b.mjs');
  });

  it('trả undefined khi message không chứa URL (vd lỗi MIME thuần)', () => {
    expect(extractChunkUrl(new Error(REAL_MIME_ERR))).toBeUndefined();
    expect(extractChunkUrl('boom')).toBeUndefined();
  });
});

// sessionStorage giả (env test = node, không có sẵn) cho hasAutoReloadBudget.
function stubSessionStorage(opts: { throwOnWrite?: boolean; seed?: Record<string, string> } = {}) {
  const m = new Map<string, string>(Object.entries(opts.seed ?? {}));
  (globalThis as any).sessionStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (opts.throwOnWrite) throw new Error('QuotaExceeded (privacy mode)');
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe('hasAutoReloadBudget', () => {
  afterEach(() => {
    delete (globalThis as any).sessionStorage;
  });

  it('true khi còn lượt và ghi được sessionStorage', () => {
    stubSessionStorage();
    expect(hasAutoReloadBudget()).toBe(true);
  });

  it('false khi đã đủ MAX_ATTEMPTS (2) trong cửa sổ — không auto-reload nữa', () => {
    stubSessionStorage({ seed: { 'chunk-reload': JSON.stringify({ at: Date.now(), count: 2 }) } });
    expect(hasAutoReloadBudget()).toBe(false);
  });

  it('false khi sessionStorage bị chặn (privacy mode) — rơi về thẻ Tải lại thủ công', () => {
    stubSessionStorage({ throwOnWrite: true });
    expect(hasAutoReloadBudget()).toBe(false);
  });

  it('KHÔNG tăng bộ đếm reload (chỉ là phép kiểm, không tiêu lượt)', () => {
    const seed: Record<string, string> = {};
    stubSessionStorage({ seed });
    hasAutoReloadBudget();
    hasAutoReloadBudget();
    // Không được ghi key 'chunk-reload' — probe tự dọn, đếm giữ nguyên.
    expect((globalThis as any).sessionStorage.getItem('chunk-reload')).toBeNull();
  });
});

describe('isReloadPending', () => {
  it('mặc định false khi chưa lên lịch reload nào', () => {
    expect(isReloadPending()).toBe(false);
  });
});
