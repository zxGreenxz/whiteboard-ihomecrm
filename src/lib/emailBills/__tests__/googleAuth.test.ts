// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.head.innerHTML = ''; vi.resetModules(); });
const scope = 'https://www.googleapis.com/auth/gmail.readonly';

describe('Google token authorization', () => {
  it('loads the GIS script once for concurrent calls and does not authorize on load', async () => {
    const { loadGoogleAuth } = await import('../googleAuth');
    const first = loadGoogleAuth(); const second = loadGoogleAuth();
    const scripts = document.querySelectorAll('script[src="https://accounts.google.com/gsi/client"]');
    expect(scripts).toHaveLength(1);
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: vi.fn(), hasGrantedAllScopes: vi.fn() } } });
    scripts[0].dispatchEvent(new Event('load'));
    await Promise.all([first, second]);
  });
  it('rejects authorization before script preparation', async () => {
    const { authorizeGmail } = await import('../googleAuth');
    await expect(authorizeGmail('fixture.apps.googleusercontent.com')).rejects.toMatchObject({ code: 'not_ready' });
  });
  it.each(['popup_closed', 'popup_failed_to_open'])('reports popup error %s', async (type) => {
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: (config: { error_callback: (error: {type:string}) => void }) => ({ requestAccessToken: () => config.error_callback({ type }) }), hasGrantedAllScopes: () => true } } });
    const { authorizeGmail } = await import('../googleAuth');
    await expect(authorizeGmail('fixture.apps.googleusercontent.com')).rejects.toMatchObject({ code: type });
  });
  it('rejects token when readonly Gmail scope was withheld', async () => {
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: (config: {callback: (response: unknown) => void}) => ({ requestAccessToken: () => config.callback({ access_token: 'synthetic-token', expires_in: 3600, scope: '' }) }), hasGrantedAllScopes: () => false } } });
    const { authorizeGmail } = await import('../googleAuth');
    await expect(authorizeGmail('fixture.apps.googleusercontent.com')).rejects.toMatchObject({ code: 'missing_scope' });
  });
  it('requests token synchronously and only returns a memory session', async () => {
    const requested = vi.fn();
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: (config: { callback: (response: unknown) => void; scope: string }) => ({ requestAccessToken: () => { expect(config.scope).toBe(scope); requested(); config.callback({ access_token: 'synthetic-token', expires_in: 3600, scope }); } }), hasGrantedAllScopes: () => true } } });
    const { authorizeGmail } = await import('../googleAuth');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const promise = authorizeGmail('fixture.apps.googleusercontent.com');
    expect(requested).toHaveBeenCalledOnce();
    expect(await promise).toMatchObject({ accessToken: 'synthetic-token' });
    expect(storage).not.toHaveBeenCalled();
    storage.mockRestore();
  });
  it('allows a retry when script loading fails', async () => {
    const { loadGoogleAuth } = await import('../googleAuth');
    const first = loadGoogleAuth();
    const rejection = expect(first).rejects.toMatchObject({ code: 'script_failed' });
    document.querySelector('script')?.dispatchEvent(new Event('error'));
    await rejection;
    const second = loadGoogleAuth();
    vi.stubGlobal('google', { accounts: { oauth2: {} } });
    document.querySelector('script')?.dispatchEvent(new Event('load'));
    await second;
  });
  it('times out authorization when Google never calls back', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken: () => {} }) } } });
    const { authorizeGmail } = await import('../googleAuth');
    const rejection = expect(authorizeGmail('fixture.apps.googleusercontent.com')).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(120_000);
    await rejection;
  });
  it('rejects invalid token lifetime', async () => {
    vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: (config: { callback: (response: unknown) => void }) => ({ requestAccessToken: () => config.callback({ access_token: 'synthetic-token', expires_in: 'NaN', scope }) }), hasGrantedAllScopes: () => true } } });
    const { authorizeGmail } = await import('../googleAuth');
    await expect(authorizeGmail('fixture.apps.googleusercontent.com')).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
