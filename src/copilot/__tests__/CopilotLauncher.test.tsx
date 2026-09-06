// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { byId, click, eventually, io, mount, resetIo, unmount } from './renderHarness';
import CopilotLauncher from '../CopilotLauncher';
beforeEach(resetIo);
afterEach(unmount);
const launcher = () => document.querySelector('[data-testid="copilot-launcher"]');
describe('mounted CopilotLauncher G0', () => {
  it('does not query gated data or render without a session', async () => {
    io.user = undefined; await mount(<CopilotLauncher />);
    expect(launcher()).toBeNull(); expect(io.entitlementQuery).not.toHaveBeenCalled(); expect(io.permissionQuery).not.toHaveBeenCalled();
  });
  it.each(['/login', '/register', '/forgot-password', '/reset-password', '/c/public', '/r/public', '/phongtrong', '/network-center/router'])('stays absent on public or excluded route %s', async path => {
    await mount(<CopilotLauncher />, path);
    expect(launcher()).toBeNull(); expect(io.entitlementQuery).not.toHaveBeenCalled(); expect(io.permissionQuery).not.toHaveBeenCalled();
  });
  it.each(['loading-entitlement', 'disabled-entitlement', 'loading-permission', 'denied-permission'])('fails closed for %s', async state => {
    if (state === 'loading-entitlement') io.entitlement = undefined;
    if (state === 'disabled-entitlement') io.entitlement!.chat_enabled = false;
    if (state === 'loading-permission') io.perms = undefined;
    if (state === 'denied-permission') io.perms = { ai_copilot: { view: false } };
    await mount(<CopilotLauncher />); expect(launcher()).toBeNull();
  });
  it('opens the real panel only when session, entitlement and permission allow it', async () => {
    await mount(<CopilotLauncher />);
    await import('../ChatPanel');
    await click(byId('copilot-launcher'));
    // React.lazy resolves asynchronously, still under act in the mount helper.
    await eventually(() => expect(byId('copilot-input')).toBeTruthy()); expect(launcher()).toBeNull();
    const close = document.querySelector<HTMLButtonElement>('button[title="Đóng"]');
    expect(close).not.toBeNull(); await click(close!); expect(launcher()).not.toBeNull();
  });
});
