// Mounts a hidden React root that hosts the wagmi + RainbowKit providers.
// The Phaser game is the actual UI; React only exists so the RainbowKit
// connect modal can render. We never render any visible React DOM other
// than the modal itself, which RainbowKit portals to <body>.
//
// Imported lazily by the web platform adapter (and only when ETH_ENABLED
// is true), so non-web bundles don't pull React in at all.

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme, useConnectModal } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import { getWagmiConfig } from './wagmi.js';

let _mounted = false;
let _root = null;

// Bridge from imperative DOM events (dispatched by walletGate.ensureWallet)
// to RainbowKit's React-only useConnectModal hook. Sits inside the provider
// tree so the hook is in scope.
function ConnectModalBridge() {
  const { openConnectModal } = useConnectModal();
  useEffect(() => {
    function handler() {
      if (openConnectModal) openConnectModal();
    }
    window.addEventListener('blockyard:eth:open-connect', handler);
    return () => window.removeEventListener('blockyard:eth:open-connect', handler);
  }, [openConnectModal]);
  return null;
}

export function mountEthProvider() {
  if (_mounted) return;
  _mounted = true;

  const host = document.createElement('div');
  host.id = 'blockyard-eth-root';
  // Modal portal target only — no visible bounds.
  host.style.cssText = 'position:fixed;width:0;height:0;left:0;top:0;pointer-events:none;';
  document.body.appendChild(host);

  const config = getWagmiConfig();
  const queryClient = new QueryClient();

  _root = createRoot(host);
  _root.render(
    React.createElement(WagmiProvider, { config },
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(RainbowKitProvider, { theme: darkTheme(), modalSize: 'compact' },
          React.createElement(ConnectModalBridge),
        ),
      ),
    ),
  );
}

export function isEthProviderMounted() {
  return _mounted;
}
