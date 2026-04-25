# LevelRegistry contract

Minimal ERC-721 used as a proof-of-authorship registry for user-submitted
Blockyard levels. See `LevelRegistry.sol`.

## One-time deploy (Base Sepolia)

The contract has no toolchain checked in — Hardhat / Foundry pick it up
verbatim. Pick whichever you prefer.

### With Foundry

```bash
# in contracts/
forge init --no-commit --force
forge install OpenZeppelin/openzeppelin-contracts
forge create LevelRegistry.sol:LevelRegistry \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK
```

The address printed by `forge create` goes into `.env` as
`VITE_BLOCKYARD_CONTRACT_ADDRESS`.

### With Hardhat

```bash
# in contracts/
npm init -y
npm i -D hardhat @nomicfoundation/hardhat-toolbox
npm i @openzeppelin/contracts
npx hardhat init   # bare-bones JS project
# add networks.baseSepolia to hardhat.config.js
npx hardhat run --network baseSepolia scripts/deploy.js
```

A minimal `scripts/deploy.js`:

```js
const hre = require('hardhat');
async function main() {
  const c = await hre.ethers.deployContract('LevelRegistry');
  await c.waitForDeployment();
  console.log('LevelRegistry deployed to', await c.getAddress());
}
main().catch((e) => { console.error(e); process.exit(1); });
```

## After deploy

1. Copy the deployed address into `.env` (`VITE_BLOCKYARD_CONTRACT_ADDRESS`).
2. Set `VITE_BLOCKYARD_ETH_ENABLED=true`.
3. Funded test account: get Base Sepolia ETH from
   <https://www.alchemy.com/faucets/base-sepolia> or any other faucet.
4. Restart `npm run dev`.

## Verifying on Basescan

Optional but useful for debugging — Basescan supports flattened source
verification. Run `forge verify-contract` or use Hardhat's
`verify` plugin against `https://sepolia.basescan.org/`.

## Why no upgrade path?

Per the approved plan: testnet only, jam scope, no real money. If we ever
ship to mainnet, deploy a fresh contract with the desired changes and bump
`VITE_BLOCKYARD_CONTRACT_ADDRESS`. Old testnet tokens stay valid for their
chain; the client reads chainId from env.
