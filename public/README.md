# Crucible · user guide

Crucible lets you execute NeftyBlocks **blends**, claim **drops**, and
open **packs** on WAX, without going through the Nefty website (which is
shut down). The smart contracts (`blend.nefty`, `neftyblocksd`,
`atomicpacksx`) are still alive on-chain; this page just composes the
right transactions and asks your wallet to sign them.

## Before you start

### 1. WAX wallet

You need **Anchor** or **WAX Cloud Wallet**:
- Anchor: https://greymass.com/anchor/
- WAX Cloud Wallet: https://wallet.wax.io/

### 2. Stake some CPU

Without Nefty subsidising CPU (`neftybrespay`), you pay your own. Stake
roughly **5 to 10 WAX in CPU** from your wallet. A typical blend
transaction uses ~1.5 ms of CPU; opening a pack uses two transactions
totalling ~3 ms.

> If you don't have enough CPU the transaction will fail with
> `exceeded the account CPU limit`. Increase your stake and retry.

### 3. Pick what to do

Three tabs at the top of the page:

- **Blend**: burn NFTs (and optionally pay tokens) to mint a fixed result.
- **Claim**: pay (or not) to mint a drop. Whitelist, NFT-proof, and free
  drops are supported.
- **Unpack**: open packs you already own. Cross-collection, two
  signatures (one to lock the pack, one to mint the resolved cards).

For Blend and Claim, you don't need to know any ID in advance: click
*Discover* and pick from the list. You can also paste a `blend_id` or
`drop_id` manually if you have one in mind. For Unpack, Crucible scans
the chain globally and only shows you the collections where you actually
hold packs right now.

## How to use

### Blend

1. **Connect your wallet** (Initialize session).
2. Pick a collection, click **Discover blends**, and select one from
   the list. Or paste a `blend_id` and click *Load blend*.
3. The page reads the recipe on-chain: ingredients, expected mint(s),
   whitelist status, token cost.
4. **Select the NFTs to burn** in the grid under each slot. The grid is
   filtered to NFTs you actually own that match the slot.
5. **Token-paying blends**: if a slot is `Pay X.YZ TICKER`, the page
   checks your balance and adds `openbal` (once per token, only if
   you've never deposited that token before) and a `transfer` action
   automatically.
6. Click **Simulate** to serialise the actions locally against the live
   ABI without broadcasting anything.
7. Click **Sign & broadcast**. Your wallet asks you to confirm each
   action, then submits.
8. A `waxblock.io` link to the transaction appears after broadcast.

### Claim

1. **Connect your wallet**.
2. Pick a collection, click **Discover drops**, and select one. Or paste
   a `drop_id` manually.
3. The page resolves the auth flavour (public / whitelist / NFT proof),
   checks your per-account claim limit, and pre-picks proof NFTs from
   your wallet when needed.
4. Choose the quantity you want to claim, simulate, then sign.

### Unpack

1. **Connect your wallet**.
2. Click **Discover my packs**. Crucible scans `atomicpacksx` globally
   and cross-references with your wallet. The cascade dropdowns light
   up:
   - **Collection**: only collections where you currently own a pack.
   - **Pack type**: the pack designs in that collection that you own.
   - **Which mint?**: optional, only when you own 2+ of the same design.
3. Pick a pack. The info card shows the rolls and possible outcomes.
4. Click **Sign step 1: send pack to atomicpacksx**. Your wallet signs
   a `transfer` with memo `unbox`.
5. The page polls the chain for the ORNG randomness callback (typically
   5 to 30 seconds, with a visible countdown). When the oracle answers,
   you're prompted for step 2.
6. Click **Sign step 2: claim N cards**. Your wallet signs a
   `claimunboxed`. The cards mint to your wallet.

If something stalls between the two signatures, your pack is **still
safe** in the `atomicpacksx` contract. Refresh the page, pick the same
pack again, and the contract will let you complete the second
transaction.

## What this page does (and does NOT do)

```
[*] deterministic blends (nosecfuse, fixed result)
[*] random blends (fuse + claim, two signatures, auto-wait between
    signatures, full outcome + in-roll odds shown before TX2)
[*] token-paying blends (FT ingredients, auto openbal + transfer)
[*] drops:
    - public                (claimdrop)
    - whitelist             (claimdropwl)
    - NFT-ownership proof   (claimwproof, auto picks the matching NFTs)
    - free drops            (no assertprice / no token transfer)
[*] packs:
    - cross-collection discovery from the global atomicpacksx table
    - auto-wait between TX1 and TX2 (ORNG poll)
    - full odds + resolved template names in the info card
[*] live ABI read on boot, survives compatible contract upgrades
[*] secure.nefty whitelist check when a blend has security_id != 0
[*] zero backend, zero telemetry, zero stored secrets
[x] ownership-secured random blends: a small minority of random
    blends require the user to send an OWNERSHIP_CHECK with specific
    proof NFTs. The current UI sends a no-op WHITELIST_CHECK; that
    works for unsecured + whitelist-secured random blends but the
    contract rejects ownership-gated ones. Picker tags the affected
    rows. A small UI extension would add this.
[x] authkey drops (claimdropkey): the drop creator must pre-sign a
    per-user message we cannot obtain.
[x] persistent storage beyond your last-used collection name.
```

## Transaction anatomy (reference)

For audits, or for manually reproducing via waxblock.io, here are the
exact action structures.

### NFT-only blend (3 actions)

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

### Blend with a token cost (adds 2 actions, first time per token)

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

### Pack unbox (two separate transactions)

```json
// TX1: announce
{
  "actions": [
    { "account": "atomicassets", "name": "transfer",
      "data": { "from": "<you>", "to": "atomicpacksx",
                "asset_ids": ["<pack_asset_id>"], "memo": "unbox" } }
  ]
}
```

Then wait for the ORNG callback (the contract reads new rows into the
`unboxassets` table scoped by `pack_asset_id`):

```json
// TX2: claim
{
  "actions": [
    { "account": "atomicpacksx", "name": "claimunboxed",
      "data": { "pack_asset_id": "<pack_asset_id>",
                "origin_roll_ids": ["0", "1", "2", "..."] } }
  ]
}
```

The `neftybrespay::paycpu` action that used to lead every Nefty trace is
gone. Nefty no longer signs for you. You pay your own CPU. Everything
else is identical.

The token contract for blends is resolved from
`blend.nefty/config/supported_tokens`, a registry of `extended_symbol`
entries mapping token symbol to contract. 159 tokens are registered at
the time of writing.

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

- WAX RPC: `wax.eosphere.io` -> `wax.greymass.com` -> `api.wax.alohaeos.com`
- AtomicAssets API: `aa.wax.atomichub.io` -> `wax.api.atomicassets.io` ->
  `aa-wax-public1.neftyblocks.com`

If one dies, the app falls back to the next.
