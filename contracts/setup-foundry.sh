#!/usr/bin/env bash
# Ubuntu setup + (optional) deploy script for the Blockyard LevelRegistry
# contract. Idempotent — safe to re-run; every step is gated on a check
# so already-installed pieces are skipped.
#
# Usage (from anywhere — the script cd's to its own directory):
#
#     bash contracts/setup-foundry.sh
#
# The script does three things:
#
#   1. Installs Foundry (forge/cast/anvil) via the official `foundryup`
#      one-liner if `forge` isn't already on PATH.
#   2. Initializes a Foundry project in the contracts/ directory and
#      installs OpenZeppelin contracts as a dependency.
#   3. Builds the contract to verify everything compiles.
#
# If the env var DEPLOYER_PK is set, the script will ALSO deploy the
# contract to Base Sepolia and print the resulting address — paste that
# into your `.env` as VITE_BLOCKYARD_CONTRACT_ADDRESS. Without
# DEPLOYER_PK the deploy step is skipped and the script just prints the
# command you'd run.
#
# Optional env vars:
#   DEPLOYER_PK     — funded private key (0x-prefixed) to deploy with.
#   RPC_URL         — RPC endpoint (defaults to Base Sepolia public RPC).

set -euo pipefail

CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RPC_URL="${RPC_URL:-https://sepolia.base.org}"

note() { printf "\033[1;36m%s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m%s\033[0m\n" "$*" >&2; }
err()  { printf "\033[1;31m%s\033[0m\n" "$*" >&2; }

# ---- 1. Install Foundry ---------------------------------------------------

# Foundry's installer drops binaries into ~/.foundry/bin; that path may
# not be on PATH for the current shell yet (it's added to ~/.bashrc by
# `foundryup` but only takes effect in new shells). Source it ourselves.
ensure_foundry_on_path() {
  if [ -d "$HOME/.foundry/bin" ]; then
    case ":$PATH:" in
      *":$HOME/.foundry/bin:"*) ;;
      *) export PATH="$HOME/.foundry/bin:$PATH" ;;
    esac
  fi
}

ensure_foundry_on_path

if ! command -v forge >/dev/null 2>&1; then
  note "[1/3] Installing Foundry…"
  if ! command -v curl >/dev/null 2>&1; then
    err "curl is required. Install it with: sudo apt-get install -y curl"
    exit 1
  fi
  curl -L https://foundry.paradigm.xyz | bash
  ensure_foundry_on_path
  if ! command -v foundryup >/dev/null 2>&1; then
    err "foundryup not found after install. Open a new terminal and rerun this script."
    exit 1
  fi
  foundryup
  ensure_foundry_on_path
else
  note "[1/3] Foundry already installed ($(forge --version | head -n 1))"
fi

# ---- 2. Initialize the project + install OpenZeppelin --------------------

cd "$CONTRACT_DIR"

if [ ! -f "foundry.toml" ]; then
  note "[2/3] Initializing Foundry project in $CONTRACT_DIR…"
  # `forge init` lays down foundry.toml + lib/ + a default src/Counter.sol
  # we don't need. --force lets it run even though the directory already
  # has files (LevelRegistry.sol + README.md). Newer Foundry versions
  # made no-commit the default — committing is now opt-in via --commit,
  # so the old `--no-commit` flag is gone. We pass --no-git for the same
  # idempotent-rerun reason.
  forge init --force --no-git .
  # Strip the generated boilerplate so only LevelRegistry.sol remains.
  rm -f src/Counter.sol test/Counter.t.sol script/Counter.s.sol 2>/dev/null || true
  rmdir test script 2>/dev/null || true
  # Move the contract into Foundry's expected `src/` layout if it isn't
  # already there. Keeps `forge create LevelRegistry.sol:LevelRegistry`
  # from the README working from either layout.
  if [ -f "LevelRegistry.sol" ] && [ ! -f "src/LevelRegistry.sol" ]; then
    mkdir -p src
    cp LevelRegistry.sol src/LevelRegistry.sol
  fi
else
  note "[2/3] Foundry project already initialized"
fi

# OpenZeppelin contracts — the LevelRegistry imports from them. `forge
# install` is idempotent: it skips if the dep is already present.
if [ ! -d "lib/openzeppelin-contracts" ]; then
  note "      cloning OpenZeppelin contracts into lib/…"
  # NOT using `forge install` — it tries to add the dep as a git
  # submodule of the nearest .git, which on WSL paths under /mnt/c
  # walks up to the blockyard project's Windows-side .git and can't
  # write the submodule metadata (Permission denied through the WSL
  # mount). A plain shallow git clone drops the source files into
  # lib/ where remappings.txt expects them; forge build doesn't care
  # whether the lib was placed by submodule or by clone.
  if ! command -v git >/dev/null 2>&1; then
    err "git is required. Install it with: sudo apt-get install -y git"
    exit 1
  fi
  mkdir -p lib
  git clone --depth 1 --branch v5.0.2 \
    https://github.com/OpenZeppelin/openzeppelin-contracts.git \
    lib/openzeppelin-contracts
  # Drop the inner .git so the parent-dir git (if any) doesn't try to
  # treat lib/openzeppelin-contracts as a sub-repo on a future operation.
  rm -rf lib/openzeppelin-contracts/.git
else
  note "      OpenZeppelin already present in lib/"
fi

# Drop a remappings.txt so `import "@openzeppelin/..."` resolves cleanly
# (the canonical npm-style import path the contract source uses).
if [ ! -f "remappings.txt" ]; then
  cat > remappings.txt <<'REMAP'
@openzeppelin/=lib/openzeppelin-contracts/
REMAP
  note "      wrote remappings.txt"
fi

# ---- 3. Build to verify -------------------------------------------------

note "[3/3] Compiling LevelRegistry…"
forge build --silent
note "      build OK"

# ---- 4. Optional deploy --------------------------------------------------

if [ -n "${DEPLOYER_PK:-}" ]; then
  note "Deploying to $RPC_URL …"
  # `forge create` prints "Deployed to: 0x…" on success. Capture stdout
  # so we can extract the address for the user.
  out="$(forge create \
    --rpc-url "$RPC_URL" \
    --private-key "$DEPLOYER_PK" \
    --broadcast \
    src/LevelRegistry.sol:LevelRegistry)"
  echo "$out"
  addr="$(printf '%s\n' "$out" | grep -oE 'Deployed to: 0x[0-9a-fA-F]{40}' | awk '{print $3}')"
  if [ -n "$addr" ]; then
    note ""
    note "Contract deployed: $addr"
    note "Add to your .env:"
    note "  VITE_BLOCKYARD_CONTRACT_ADDRESS=$addr"
    note "  VITE_BLOCKYARD_ETH_ENABLED=true"
  fi
else
  note ""
  note "Setup complete. To deploy, set DEPLOYER_PK to a funded Base Sepolia"
  note "key and rerun this script, OR run manually:"
  note ""
  note "  cd $CONTRACT_DIR"
  note "  forge create \\"
  note "    --rpc-url $RPC_URL \\"
  note "    --private-key \$DEPLOYER_PK \\"
  note "    --broadcast \\"
  note "    src/LevelRegistry.sol:LevelRegistry"
  note ""
  note "Get Base Sepolia test ETH at https://www.alchemy.com/faucets/base-sepolia"
fi
