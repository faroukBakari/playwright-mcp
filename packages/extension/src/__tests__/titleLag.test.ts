/**
 * Title lag characterization test.
 *
 * Chrome fires tabs.onUpdated incrementally — url arrives before title.
 * Between the url event and the title event, the registry has the new URL
 * but the stale title. This is inherent to Chrome's event model.
 *
 * Decision: ACCEPTED as cosmetic. The window is ~50-500ms during page load.
 * The registry converges once the title event fires. No fix needed — adding
 * a debounce or poll would add complexity for negligible user-visible benefit.
 * Agents that need the current title should call browser_select_tab (which
 * reads live state) rather than relying on cached registry titles.
 */

import { describe, it, expect } from 'vitest';
import * as tabRegistry from '../tabRegistry';

describe('title lag characterization', () => {
  it('url updates before title during simulated navigation', async () => {
    // Initial state: page at old URL with old title
    await tabRegistry.upsertOnAttach(42, 1, { url: 'https://old.com', title: 'Old Page' });

    // Chrome fires url change first (navigation committed)
    await tabRegistry.onTabUpdated(42, { url: 'https://new.com' } as chrome.tabs.TabChangeInfo);

    const afterUrl = await tabRegistry.getAll();
    expect(afterUrl[0].url).toBe('https://new.com');
    expect(afterUrl[0].title).toBe('Old Page'); // ← stale title (expected)

    // Chrome fires title change later (HTML parsed)
    await tabRegistry.onTabUpdated(42, { title: 'New Page' } as chrome.tabs.TabChangeInfo);

    const afterTitle = await tabRegistry.getAll();
    expect(afterTitle[0].url).toBe('https://new.com');
    expect(afterTitle[0].title).toBe('New Page'); // ← converged
  });

  it('registry is consistent after full update sequence', async () => {
    await tabRegistry.upsertOnAttach(42, 1, { url: 'https://a.com', title: 'A' });

    // Full Chrome onUpdated sequence for in-tab navigation
    await tabRegistry.onTabUpdated(42, { status: 'loading' } as chrome.tabs.TabChangeInfo);
    await tabRegistry.onTabUpdated(42, { url: 'https://b.com' } as chrome.tabs.TabChangeInfo);
    await tabRegistry.onTabUpdated(42, { status: 'complete' } as chrome.tabs.TabChangeInfo);
    await tabRegistry.onTabUpdated(42, { title: 'B' } as chrome.tabs.TabChangeInfo);

    const final = (await tabRegistry.getAll())[0];
    expect(final.url).toBe('https://b.com');
    expect(final.title).toBe('B');
    expect(final.status).toBe('complete');
  });
});
