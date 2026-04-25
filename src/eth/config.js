// Ethereum / chain configuration. Reads Vite env vars at build time so the
// adapter can stay tree-shake-friendly: when VITE_BLOCKYARD_ETH_ENABLED is
// false (the default for fresh checkouts) the wallet UX is fully disabled
// and no on-chain calls are issued.
//
// All four address/chain values are set in `.env` per `.env.example`. The
// contract is `contracts/LevelRegistry.sol`, deployed once to Base Sepolia.

export const ETH_ENABLED = import.meta.env.VITE_BLOCKYARD_ETH_ENABLED === 'true';

export const CHAIN_ID = Number(import.meta.env.VITE_BLOCKYARD_CHAIN_ID || 84532);
export const CONTRACT_ADDRESS = import.meta.env.VITE_BLOCKYARD_CONTRACT_ADDRESS || '';
export const RPC_URL = import.meta.env.VITE_BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
export const WALLETCONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

// Minimal ABI fragment — only what we actually call. Keeping it inline avoids
// a JSON import roundtrip and makes the wagmi `writeContract` types happy.
export const LEVEL_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'uri', type: 'string' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'LevelMinted',
    inputs: [
      { name: 'tokenId', type: 'uint256', indexed: true },
      { name: 'owner',   type: 'address', indexed: true },
      { name: 'tokenURI', type: 'string', indexed: false },
    ],
  },
];

export function explorerTokenUrl(tokenId) {
  if (!CONTRACT_ADDRESS || tokenId == null) return null;
  return `https://sepolia.basescan.org/token/${CONTRACT_ADDRESS}?a=${tokenId}`;
}
