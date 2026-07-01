import { describe, it, expect } from 'vitest';
import { isChunkLoadError, extractChunkUrl } from '../chunkReload';

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
