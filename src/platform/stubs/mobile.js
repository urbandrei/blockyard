import { createBaseAdapter } from '../base.js';

// Mobile (iOS / Android via Capacitor) adapter — stub. Real implementation
// will wrap with Capacitor and integrate RevenueCat for cross-platform IAP
// (StoreKit on iOS, Play Billing on Android), plus optional AdMob / MAX.
// CRITICAL: External payment flows violate Apple & Google TOS — Ko-fi unlocks
// MUST remain stubbed here; purchases go through native IAP only.

export default (function createMobileStub() {
  const base = createBaseAdapter('mobile');
  return Object.assign(base, {
    async init() { console.log('[mobile] stub adapter loaded'); },
  });
})();
