# Crucible — user guide

Crucible lets you execute a NeftyBlocks blend (`blend.nefty`) on WAX
**without going through the Nefty website** (which is shut down). The smart
contract is still alive on-chain; this page just composes the transaction
and asks your wallet to sign it.

## Before you start

### 1. WAX wallet

You need **Anchor** or **WAX Cloud Wallet**:
- Anchor: https://greymass.com/anchor/
- WAX Cloud Wallet: https://wallet.wax.io/

### 2. Stake some CPU

Without Nefty subsidizing CPU (`neftybrespay`), you pay your own. Stake
roughly **5–10 WAX in CPU** from your wallet. A typical blend transaction
uses ~1.5 ms of CPU.

> If you don't have enough CPU the transaction will fail with
> `exceeded the account CPU limit`. Increase your stake and retry.

### 3. Know your blend_id

- On **AtomicHub**, open one of your old blends — the `blend_id` is in the
  URL or in the blend details.
- The collection is auto-detected from the on-chain blend row, you don't
  need to know it.

You can also inspect the contract directly:
https://wax.bloks.io/account/blend.nefty?loadContract=true&tab=Tables
(table `blends`, scope `blend.nefty`).

## How to use

1. **Connect your wallet** (Initialize session).
2. **Enter the `blend_id`** and click *Load blend*.
3. The page reads the blend on-chain: ingredients, expected mint(s),
   whitelist status, deterministic check.
4. **Select the NFTs to burn** in the grid below each slot.
   The grid is filtered to NFTs you actually own that match the slot.
5. **Token-paying blends**: if a slot is `Pay X.YZ TICKER`, the page checks
   your balance for that token. The eventual transaction will include the
   `openbal` (once per token, only if you've never deposited it before) and
   the token transfer automatically.
6. Click **Simulate** to serialize the actions locally against the live
   ABI without broadcasting anything.
7. Click **Sign & broadcast**: your wallet asks you to confirm each action
   then submits.
8. A bloks.io link to the transaction is shown after broadcast.

## What this page does (and does NOT do)

✅ Handles **deterministic blends** (`nosecfuse` action — fixed result).
✅ Handles **token-paying blends** (FT ingredients) — adds the `openbal` and
   token `transfer` actions automatically.
✅ Handles **drops/claims** on `neftyblocksd`:
   - public drops (`claimdrop`)
   - per-account whitelist drops (`claimdropwl`)
   - NFT-ownership-proof drops (`claimwproof`) — the page auto-selects
     matching NFTs from your wallet
   - free drops (no `assertprice` / no token transfer needed)
✅ Reads the live `blend.nefty` and `neftyblocksd` ABIs on boot, so it
   survives any contract upgrade that doesn't change semantics.
✅ Checks `secure.nefty` whitelists when a blend has `security_id ≠ 0`.
✅ Zero backend. Zero telemetry. Pure static frontend.

❌ **Does NOT** handle `secfuse` blends (random results with commit/reveal
   via ORNG). That needs two transactions and reveal monitoring; it's not
   built yet.
❌ **Does NOT** handle `claimdropkey` (authkey-gated drops) — the drop
   creator must pre-sign a per-user message and we have no way to obtain
   it.
❌ Does not store anything.

## Transaction anatomy (reference)

For audits or for manually reproducing via bloks.io, here is the exact
structure for a deterministic blend.

**NFT-only blend** (3 actions):

```json
{
  "actions": [
    { "account": "blend.nefty",  "name": "announcedepo",
      "data": { "owner": "<you>", "count": <N> } },
    { "account": "atomicassets", "name": "transfer",
      "data": { "from": "<you>", "to": "blend.nefty",
                "asset_ids": [...], "memo": "deposit" } },
    { "account": "blend.nefty",  "name": "nosecfuse",
      "data": { "claimer": "<you>", "blend_id": <id>,
                "transferred_assets": [...], "own_assets": [] } }
  ]
}
```

**Blend with a token cost** (adds 2 actions, first time per token):

```json
{
  "actions": [
    { "account": "blend.nefty",  "name": "openbal",
      "data": { "owner": "<you>", "token_symbol": "8,UPMAX" } },
    { "account": "<token contract>", "name": "transfer",
      "data": { "from": "<you>", "to": "blend.nefty",
                "quantity": "105.00000000 UPMAX", "memo": "deposit" } },
    { "account": "blend.nefty",  "name": "announcedepo",  "data": { ... } },
    { "account": "atomicassets", "name": "transfer",       "data": { ... } },
    { "account": "blend.nefty",  "name": "nosecfuse",      "data": { ... } }
  ]
}
```

The `neftybrespay::paycpu` action that used to lead the trace is gone:
Nefty no longer signs for you. You pay your own CPU. Everything else is
identical.

The token contract is resolved from `blend.nefty/config/supported_tokens`
(a registry of `extended_symbol` entries mapping token symbol to
contract). 159 tokens are registered at the time of writing.

## Hosting

The page is 100 % static. After `npm run build`:

```
dist/
├── index.html
├── README.md
└── assets/...
```

Push `dist/` to:
- **GitHub Pages**
- **IPFS** (`ipfs add -r dist`)
- **Cloudflare Pages**
- or any HTTP server

No environment variables. No secrets.

## Public endpoints (automatic failover)

- WAX RPC: `wax.eosphere.io` → `wax.greymass.com` → `api.wax.alohaeos.com`
- AtomicAssets API: `aa.wax.atomichub.io` → `wax.api.atomicassets.io` →
  `aa-wax-public1.neftyblocks.com`

If one dies, the app falls back to the next.
