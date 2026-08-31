import { describe, expect, it } from 'vitest';
import {
  COPILOT_PAGE_CONTRACTS,
  copilotPageByRoute,
  copilotRouteForKey,
} from '../registry';

describe('Copilot page contracts', () => {
  it('exposes declared contracts and normalizes trailing slash and detail routes', () => {
    expect(COPILOT_PAGE_CONTRACTS.length).toBeGreaterThanOrEqual(3);
    expect(copilotPageByRoute('/apartments/')).toMatchObject({ key: 'rooms.list', route: '/apartments' });
    expect(copilotPageByRoute('/apartments/123')).toMatchObject({ key: 'rooms.detail', canonicalRoute: '/apartments' });
  });

  it('returns canonical route for a declared key and denies unknown keys', () => {
    expect(copilotRouteForKey('invoices.list')).toBe('/invoices');
    expect(copilotRouteForKey('unknown')).toBeUndefined();
  });

  it('keeps high-risk pilot pages read/navigation only', () => {
    for (const page of COPILOT_PAGE_CONTRACTS) {
      if (page.dataClass === 'financial' || page.dataClass === 'security') {
        expect(['read', 'navigate']).toContain(page.mode);
      }
    }
  });
});
