// Mints a Level NFT to the connected wallet. The contract is deployed once
// per environment; address comes from VITE_BLOCKYARD_CONTRACT_ADDRESS.
//
// Returns { tokenId, txHash }. tokenId is a bigint-safe decimal string so
// JSON serialization / localStorage roundtrips work without BigInt loss.

import { writeContract, waitForTransactionReceipt } from '@wagmi/core';
import { decodeEventLog, getAddress } from 'viem';
import { getWagmiConfig } from './wagmi.js';
import { CONTRACT_ADDRESS, LEVEL_REGISTRY_ABI } from './config.js';
import { ensureWallet } from './walletGate.js';

export async function mintLevel({ tokenURI }) {
  if (!CONTRACT_ADDRESS) throw new Error('CONTRACT_ADDRESS not configured');
  if (!tokenURI) throw new Error('tokenURI required');
  await ensureWallet();

  const config = getWagmiConfig();
  const txHash = await writeContract(config, {
    address: getAddress(CONTRACT_ADDRESS),
    abi: LEVEL_REGISTRY_ABI,
    functionName: 'mint',
    args: [tokenURI],
  });

  const receipt = await waitForTransactionReceipt(config, { hash: txHash });

  // The Transfer + LevelMinted events are emitted from our contract. We
  // parse LevelMinted because it carries the tokenId in its first indexed
  // topic and is unique to this contract (Transfer is shared with anything
  // that re-uses ERC-721).
  const tokenId = extractTokenId(receipt.logs);
  if (tokenId == null) {
    throw new Error('mint succeeded but LevelMinted event was not found in receipt logs');
  }
  return { tokenId: tokenId.toString(), txHash };
}

function extractTokenId(logs) {
  for (const log of logs || []) {
    try {
      const decoded = decodeEventLog({
        abi: LEVEL_REGISTRY_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'LevelMinted') {
        return decoded.args.tokenId;
      }
    } catch (e) {
      // Not a log from our ABI — skip.
    }
  }
  return null;
}
