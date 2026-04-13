/**
 * Cross-extension iframe removal.
 *
 * Prevents security software (Kaspersky, etc.) from injecting chrome-extension://
 * iframes that cause Chrome to detach the debugger. Runs at document_start to
 * intercept injections before navigation commits.
 *
 * See: SO Q78622517 (wOxxOm, June 2024), Chromium debugger_api.cc
 */

const OUR_ORIGIN = chrome.runtime.getURL('');

// Track closed shadow roots via monkey-patch (must run before any other script)
const closedShadows = new WeakMap<Element, ShadowRoot>();
const _origAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init: ShadowRootInit): ShadowRoot {
  const shadow = _origAttachShadow.call(this, init);
  if (init.mode === 'closed')
    closedShadows.set(this, shadow);
  return shadow;
};

function isHostileIframe(el: Element): boolean {
  if (el.tagName !== 'IFRAME') return false;
  const src = (el as HTMLIFrameElement).src;
  return !!src && src.startsWith('chrome-extension://') && !src.startsWith(OUR_ORIGIN);
}

function sweep(root: ParentNode): void {
  for (const el of root.querySelectorAll(
    `iframe[src^="chrome-extension:"]:not([src^="${OUR_ORIGIN}"])`
  )) el.remove();
}

function sweepDeep(root: ParentNode): void {
  sweep(root);
  for (const el of root.querySelectorAll('*')) {
    const shadow = closedShadows.get(el) || el.shadowRoot;
    if (shadow) sweepDeep(shadow);
  }
}

// Initial sweep
sweepDeep(document.documentElement);

// Watch for re-injections
new MutationObserver(mutations => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      const el = node as Element;
      if (isHostileIframe(el)) { el.remove(); continue; }
      // Check children (wrapper elements)
      sweep(el);
      // Check shadow roots on new elements
      const shadow = closedShadows.get(el) || el.shadowRoot;
      if (shadow) sweepDeep(shadow);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });
