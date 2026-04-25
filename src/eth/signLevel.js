// Signs the canonical level message with the connected wallet using
// personal_sign (EIP-191). Returns { address, signature, message } where
// `message` is the exact bytes the user saw in their wallet prompt — both
// client and server feed this to verifyMessage to confirm the signer.

import { signMessage } from '@wagmi/core';
import { getWagmiConfig } from './wagmi.js';
import { signingMessage } from './canonical.js';
import { CHAIN_ID } from './config.js';
import { ensureWallet } from './walletGate.js';

export async function signLevel(level) {
  const address = await ensureWallet();
  const message = signingMessage(level, CHAIN_ID);
  const signature = await signMessage(getWagmiConfig(), { message, account: address });
  return { address, signature, message };
}
