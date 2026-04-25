// Wagmi + RainbowKit configuration. Imported lazily from the web platform
// adapter so non-web builds tree-shake the entire web3 stack out.

import { http } from 'viem';
import { baseSepolia } from 'wagmi/chains';
import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { CHAIN_ID, RPC_URL, WALLETCONNECT_PROJECT_ID } from './config.js';

let _config = null;

export function getWagmiConfig() {
  if (_config) return _config;

  // We deliberately only register Base Sepolia — the wallet picker will
  // refuse to connect on any other chain, which is the correct behavior
  // for a testnet-only proof-of-authorship registry. If we ever add
  // mainnet, expand the chains array AND switch on CHAIN_ID.
  if (CHAIN_ID !== baseSepolia.id) {
    console.warn(
      `[eth] CHAIN_ID=${CHAIN_ID} but only Base Sepolia (${baseSepolia.id}) is wired up. Update wagmi.js if you intend to support another chain.`
    );
  }

  _config = getDefaultConfig({
    appName: 'Blockyard',
    projectId: WALLETCONNECT_PROJECT_ID || 'blockyard-dev',
    chains: [baseSepolia],
    transports: { [baseSepolia.id]: http(RPC_URL) },
    ssr: false,
  });
  return _config;
}
