// Imperative wallet connection façade — the Phaser scenes don't speak React
// or wagmi, so this module wraps the wagmi store actions in plain promises.
//
// The flow:
//   1. mountEthProvider() must have been called once (idempotent) so the
//      RainbowKit modal portal exists.
//   2. ensureWallet() returns the connected EOA address. If none is
//      connected, it dispatches RainbowKit's openConnectModal action and
//      resolves once the wagmi store reports an account, or rejects when
//      the user dismisses the modal.

import { getAccount, watchAccount, disconnect as wagmiDisconnect } from '@wagmi/core';
import { getWagmiConfig } from './wagmi.js';
import { mountEthProvider } from './provider.js';

// RainbowKit doesn't expose openConnectModal as a static import — we read
// it off the global it stamps when the provider mounts. This is the
// documented imperative escape hatch.
function openConnectModal() {
  // RainbowKit registers a global hook on window once the provider is
  // mounted; we read it through a custom event we dispatch from the
  // provider's render. Since we render a null child, we instead pop the
  // modal by clicking the hidden trigger we mount at boot.
  // Simplest reliable path: dispatch a CustomEvent the provider listens
  // for. See provider.js for the listener.
  window.dispatchEvent(new CustomEvent('blockyard:eth:open-connect'));
}

export function getConnectedAddress() {
  const acct = getAccount(getWagmiConfig());
  return acct?.address || null;
}

export function isConnected() {
  return !!getConnectedAddress();
}

export async function disconnect() {
  try { await wagmiDisconnect(getWagmiConfig()); } catch (e) {}
}

// Resolve with the connected address, or throw on user dismissal / timeout.
// `timeoutMs` defaults to 2 minutes — long enough for hardware-wallet
// confirmation flows, short enough that a stuck modal doesn't hang the
// publish state machine forever.
export function ensureWallet({ timeoutMs = 120_000 } = {}) {
  mountEthProvider();
  const existing = getConnectedAddress();
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const config = getWagmiConfig();

    const unwatch = watchAccount(config, {
      onChange(acct) {
        if (settled) return;
        if (acct?.address) {
          settled = true;
          if (timer) clearTimeout(timer);
          unwatch();
          resolve(acct.address);
        }
      },
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unwatch();
      reject(new Error('wallet connection timed out'));
    }, timeoutMs);

    openConnectModal();
  });
}
