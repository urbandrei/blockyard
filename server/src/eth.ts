// Signature verification for level submissions. Uses viem's verifyMessage,
// which handles both standard secp256k1 EOA signatures and EIP-1271 smart
// contract wallets. The latter would require an RPC connection to evaluate
// isValidSignature — we skip it for now and accept EOA-only.

import { verifyMessage, getAddress, isAddress } from 'viem';
import { signingMessage } from './canonical.ts';

export interface VerifyArgs {
  level: Record<string, unknown>;
  chainId: number;
  authorWallet: string;
  authorSignature: string;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  /** Address normalized to EIP-55 checksummed form on success. */
  address?: string;
}

/**
 * Verify that `authorSignature` is a valid EOA signature over the canonical
 * level message produced by signingMessage(). Mirrors src/eth/signLevel.js.
 */
export async function verifyLevelSignature(args: VerifyArgs): Promise<VerifyResult> {
  if (!args.authorWallet || !isAddress(args.authorWallet)) {
    return { ok: false, error: 'authorWallet is missing or invalid' };
  }
  if (!args.authorSignature || typeof args.authorSignature !== 'string') {
    return { ok: false, error: 'authorSignature is missing' };
  }
  const message = signingMessage(args.level, args.chainId);
  try {
    const ok = await verifyMessage({
      address: args.authorWallet as `0x${string}`,
      message,
      signature: args.authorSignature as `0x${string}`,
    });
    if (!ok) return { ok: false, error: 'signature does not match wallet' };
    return { ok: true, address: getAddress(args.authorWallet) };
  } catch (err: any) {
    return { ok: false, error: `verify failed: ${err?.message || 'unknown'}` };
  }
}
