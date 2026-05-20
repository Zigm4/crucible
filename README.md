```
   ▲ ▲ ▲
    \|/
   ◆ ◆ ◆        C R U C I B L E
    /|\
   ─ ─ ─        on-chain blends · drops · packs · upgrades · waxdao
                no website, no backend, no trust required
```

```
> SESSION OPEN

  Nefty.io shut down its UI. WaxDAO's website went dark too. The
  smart contracts both relied on are still running on WAX, 24/7,
  exactly as they were. Crucible is the missing client for ALL of
  them.

  Burn NFTs, claim drops, open packs, mutate NFTs in place, craft
  via WaxDAO recipes. All directly on-chain, without going through
  any platform that can disappear again.
```

---

## tl;dr

A **single HTML file** with bundled JavaScript that talks straight to
five public WAX smart contracts (`blend.nefty`, `neftyblocksd`,
`atomicpacksx`, `up.nefty`, `waxdaomarket`). Your wallet signs the
transactions; the page never sees a private key, never phones home,
never stores anything. The blend / drop / upgrade / craft fees that
always existed still go where they always went, nothing comes to me.

```
$ crucible --status
contracts...... blend.nefty + neftyblocksd
                + atomicpacksx + up.nefty
                + waxdaomarket                       [LIVE]
backend........ none                                 [BY DESIGN]
telemetry...... none                                 [BY DESIGN]
cookies........ none                                 [BY DESIGN]
service charge. 0 %                                  [GUARANTEED]
audit.......... open source                          [GO READ IT]
```

```
$ crucible --layout
                                                       wallet
   ┌─────────────────────────────────────────────────────●──┐
   │  [ NEFTYBLOCKS ]   [ WAXDAO ]                          │  <- platform pills
   ├─────────────────────────────────────────────────────────┤
   │  Blend | Claim | Unpack | Upgrade                       │  <- tabs (per platform)
   └─────────────────────────────────────────────────────────┘
   addressable via hash:  #/nefty/blend/43444
                          #/nefty/claim/237418
                          #/nefty/upgrade/447
                          #/waxdao/blend/1921
```

---

## --- Threat model ---

Crucible's whole point is to **remove people from the trust path**.
You shouldn't have to trust me, my hosting, my domain, my email. The
only thing you should trust is the smart contract code itself, which
has been running for years and is enforced byte-for-byte by the chain.

| Layer                       | Who you trust            | How to verify |
| --------------------------- | ------------------------ | ------------- |
| The WAX chain               | The WAX validators        | Use multiple RPCs (the app already does failover) |
| `blend.nefty` contract      | Its on-chain code         | `cleos get code blend.nefty`, unchanged since 2024 |
| `neftyblocksd` contract     | Its on-chain code         | Same |
| `atomicpacksx` contract     | Its on-chain code         | Same, plus the ORNG oracle |
| `up.nefty` contract         | Its on-chain code         | Same |
| `waxdaomarket` contract     | Its on-chain code         | Same |
| WharfKit (signing library)  | Greymass + audit-friendly | Open source on GitHub |
| Crucible's front-end        | **You. Read it.**         | This repo + the [verifier scripts](#--verify-everything--) below |

Remove every Crucible-specific layer from that table and trust only
WAX and the five contracts above: the worst Crucible can do is *fail
to build the right transaction*. It can't steal funds, drain wallets,
or front-run you. Your wallet shows every action before signing and
would refuse anything weird.

---

## --- Privacy ---

```
[*] no backend, no server, no API key, no database
[*] no analytics, no telemetry, no Sentry, no Google Tag, nothing
[*] no cookies; localStorage is never written (zero session state
    persists between visits, every page load is a clean boot)
[*] third-party requests are limited to public WAX RPC nodes (chain
    reads), AtomicHub's public AtomicAssets API (NFT name enrichment),
    and Google Fonts (purely cosmetic, remove in 30s by editing
    index.html)
[*] your private key never leaves your wallet. WharfKit hands the
    unsigned transaction to Anchor / WAX Cloud Wallet, which signs
    locally and returns a signature. The page never sees a secret.
```

---

## --- What it does ---

### BLEND tab · `blend.nefty`

Every blend Nefty's UI ever submitted was a 3-or-5 action transaction
signed by your wallet. Crucible builds the same thing:

```
1. blend.nefty::announcedepo            "I'm depositing N NFTs"
2. atomicassets::transfer memo=deposit  "Here are the N NFTs"
3. blend.nefty::nosecfuse               "Burn them, mint my result"
```

For blends that also cost tokens (UPMAX, GUILD, WAX, etc.), two more
actions lead the sequence:

```
0a. blend.nefty::openbal      "Open a balance slot for this token"
                              (only the first time per token, ever)
0b. <token>::transfer         "Here's the payment"
```

```
[*] auto-detects active blends per collection
[*] reads the live recipe + ingredient list straight from the chain
[*] checks secure.nefty whitelists before letting you sign
[*] resolves the token contract from blend.nefty/config/supported_tokens
    (159 tokens registered as of 2026)
[*] random blends (fuse + claim, two signatures) with auto-wait
    between TX1 and TX2 and a full breakdown of the resolved outcome
    + the in-roll odds
```

Random blends (any roll with 2+ outcomes) follow:

```
TX 1 - announcedepo + atomicassets::transfer + blend.nefty::fuse
       (the contract either resolves synchronously or queues an
        ORNG job)

       ... wait for claimassets[claimer] to gain a new row ...

TX 2 - blend.nefty::claim  claim_id, roll_indexes
       (mints the resolved cards to your wallet)
```

### CLAIM tab · `neftyblocksd`

Drop claims. Same idea, different contract:

```
1. neftyblocksd::assertprice            "Lock this price"
2. <token>::transfer memo=deposit       "Here's the payment"
3. neftyblocksd::<claim variant>        "Claim my drop"
```

Crucible handles four claim variants:

| Variant         | Gate                                          | Action          |
| --------------- | --------------------------------------------- | --------------- |
| Public          | Open to anyone                                | `claimdrop`     |
| Whitelist       | Your account is in `whitelists` table         | `claimdropwl`   |
| NFT proof       | You hold specific NFTs (e.g. 4 templates)     | `claimwproof`   |
| Authkey         | Drop creator pre-signed a per-user message    | *unsupported*, off-chain secret only the creator has |

For free drops, steps 1 and 2 are skipped entirely, only the claim
action is signed.

```
[*] drop names resolved from the primary mint template via the
    AtomicAssets indexer when on-chain display_data is empty, so
    the picker shows "Triglave Hero" instead of "Drop #237418"
[*] paid drops: pre-flight balance check per settlement token. If
    you're eligible but short on tokens, the action card shows the
    exact top-up needed and disables Sign & claim until you fund
    your wallet
[*] NFT-proof drops: even when your wallet doesn't satisfy the
    rule, the row stays selectable so you can read the requirement
    in plain English ("hold 1 NFT from template 12345 + 2 NFTs
    from schema X") and know exactly what to buy
```

### UNPACK tab · `atomicpacksx`

Opening a pack is a commit-reveal dance with the ORNG oracle, so it
takes **two wallet signatures** instead of one:

```
TX 1 - atomicassets::transfer  to=atomicpacksx, memo="unbox"
       "Take this pack into custody, ask the oracle for randomness."

       ... 5..30 seconds while ORNG calls the contract back ...

TX 2 - atomicpacksx::claimunboxed  pack_asset_id, origin_roll_ids
       "Randomness is in, mint my cards."
```

The same contract handles every collection on WAX. Crucible scans
`atomicpacksx` globally and only lists collections where your wallet
currently holds at least one openable pack. You then pick: collection,
pack type, specific mint (when you own more than one of the same).

```
[*] cross-collection pack discovery
[*] auto-wait between TX1 and TX2, with a cancel button if ORNG
    stalls (your pack stays safe on-chain, resume later)
[*] full odds breakdown per roll, with resolved template names
[*] reset and open another mint without re-discovering
```

### UPGRADE tab · `up.nefty`

The fourth pillar, new in v0.4. Upgrades **mutate** existing NFTs you
own: the asset stays in your wallet, only its on-chain `mutable_data`
changes (image, colour, level, etc.). The action set mirrors
`blend.nefty` but the differentiator is `assets_to_upgrade`:

```
[0a. up.nefty::openbal               once per (owner, FT symbol) ever]
[0b. <token>::transfer memo=deposit  one per FT ingredient]
 1.  up.nefty::announcedepo          { owner, count }      <- only when
 2.  atomicassets::transfer          memo=deposit            burning NFTs
 3.  up.nefty::upgrade               { claimer, upgrade_id,
                                       transferred_assets,
                                       own_assets,
                                       assets_to_upgrade }  <- mutated
                                                              in place
```

Whitelist / ownership-gated upgrades use `upgradesec` (same shape +
`security_check` variant). RNG upgrades use `up.nefty/orngjobs`,
identical to the blend RNG flow. Both are detected and tagged in the
picker; first-cut UI executes the deterministic FT-cost case (the
common one).

```
[*] per-collection discovery from up.nefty/upgrades
[*] alphabetical sort by name, status badges (active / sold-out /
    ended / upcoming / hidden)
[*] per-spec NFT picker (matches schema + template requirements
    against your wallet)
[*] per-ingredient FT balance check
[*] zero-CPU sanity check: the contract row is read live each time,
    no stale cache
```

### WAXDAO BLEND tab · `waxdaomarket`

WaxDAO is a parallel ecosystem to NeftyBlocks on WAX. Its blends live
on a different contract (`waxdaomarket`) and use a different action
shape: instead of one big NFT transfer carrying all ingredients, each
ingredient slot gets its OWN `atomicassets::transfer` with a
slot-indexed memo. Crucible drives the contract directly even though
waxdao.io is currently down.

```
1.  waxdaomarket::assertblend           { blend_ID, user, unique_id }
[2. <token>::transfer  to=waxdaomarket
                        memo="|blend_deposit|<id>|0|"]
 3. atomicassets::transfer  to=waxdaomarket
                            memo="|blend_deposit|<id>|1|"
 4. atomicassets::transfer  to=waxdaomarket
                            memo="|blend_deposit|<id>|2|"
 ...                          one transfer per NFT ingredient slot
```

Switch to the **WAXDAO** platform pill at the top of the page to
access it. The two platforms have independent ID spaces, so blend
`#1127` on `blend.nefty` and blend `#1127` on `waxdaomarket` are
totally different recipes.

```
[*] per-collection discovery from waxdaomarket/blends
[*] picker with active / sold-out / ended / upcoming status chips
[*] per-slot NFT picker filtered by template / schema / collection
[*] per-slot FT balance check (token contract resolved from the
    ingredient's own field, no global registry needed)
[*] one signature for the whole multi-action transaction, byte-for-
    byte equivalent to a real WaxDAO blend from 2024
```

---

## --- Shareable links ---

Every blend, drop, and upgrade has its own deep-link URL. Once you've
picked one, the page address updates automatically:

```
#/nefty/blend/43444     -- a NeftyBlocks blend
#/nefty/claim/237418    -- a NeftyBlocks drop
#/nefty/upgrade/447     -- a NeftyBlocks upgrade
#/waxdao/blend/1921     -- a WaxDAO blend (e.g. STARBORE)
#/nefty                 -- platform default tab, no entity
#/waxdao                -- platform default tab, no entity
```

Anyone opening one of those URLs lands directly on the right platform
+ tab. The recipe loads automatically, even if no wallet is connected
yet: a banner inside the "Connect wallet" card tells the visitor what
they're looking at and invites them to sign in.

```
[*] one-click "share link" button in every info card (zone 3)
    copies the current URL to the clipboard
[*] no history pollution: hash writes use replaceState so the
    back button never gets clogged with intermediate states
[*] hash changes work in reverse: pasting / typing one of the
    URLs above into the address bar triggers the same auto-load
[*] no wallet required to READ a recipe, only to sign it
```

---

## --- Verify everything ---

This is the strongest argument against trusting me. Four standalone
Node scripts reconstruct real historical transactions from the chain
and prove the action payloads our code generates match what was
actually signed, **byte for byte**.

```bash
$ node scripts/verify-trace.mjs
=== NFT-only blend 43444 ===
   ✓ blend.nefty::announcedepo
   ✓ atomicassets::transfer
   ✓ blend.nefty::nosecfuse

=== Token blend 43802 ===
   ✓ blend.nefty::openbal
   ✓ underpunks55::transfer  (105.00000000 UPMAX)
   ✓ blend.nefty::announcedepo
   ✓ atomicassets::transfer
   ✓ blend.nefty::nosecfuse
```

```bash
$ node scripts/verify-drops.mjs
=== Drop 237418 · claimdrop (paid 50 WAX) ===   ✓
=== Drop 237297 · claimwproof (paid 10K GUILD,
                                NFT proof)  ===  ✓
```

```bash
$ node scripts/verify-packs.mjs
=== Pack unbox (zigm4.gm, pack 1099968251815) ===   ✓
```

```bash
$ node scripts/verify-upgrades.mjs
=== FT-only upgrade 447 (10 WAX, no NFT cost) ===   ✓
=== FT+NFT upgrade 323 ===                          ✓
```

```bash
$ node scripts/verify-waxdao.mjs
=== Back Scratcher blend #1127 (waxdaomarket) ===
   ✓ waxdaomarket::assertblend
   ✓ underpunks55::transfer memo="|blend_deposit|1127|0|"
   ✓ atomicassets::transfer memo="|blend_deposit|1127|1|"
   ✓ atomicassets::transfer memo="|blend_deposit|1127|2|"
   ✓ atomicassets::transfer memo="|blend_deposit|1127|3|"
```

```bash
$ node scripts/verify-discover-chain.mjs
# Walks ~30K+ rows of blend.nefty/blends in 16 parallel chunks
# (~5 seconds). Confirms every Underpunks blend is reachable
# on-chain and that two specific reference blends appear.
```

Translation: I didn't write the action structures from memory or a
spec PDF. I pulled real transactions from a user's own on-chain
history (thanks zigm4.gm), decoded each action's parameters, then
wrote a builder that reproduces them. The proof is in `scripts/`,
re-run it whenever you doubt me.

---

## --- How this was built ---

Short version, for forks or for anyone wanting to do the same for
another defunct platform.

1. **Pulled live ABIs** via `/v1/chain/get_abi`. The ABI is the
   contract's self-description: every table, every action, every
   struct. No documentation needed, the chain is the documentation.
2. **Decoded historical transactions** from a wallet that had used
   the old UI. Hyperion's `/v2/history/get_transaction` reveals every
   action with its parameters. Cross-referenced against the ABI to
   understand each field's role.
3. **Re-implemented the action builders** purely against the ABI.
   Serialisation is local via WharfKit's `Action.from(...)`. No
   remote `abi_json_to_bin` call (most public RPCs disable it
   anyway).
4. **Verified equivalence**: for each historical transaction, encode
   our actions and compare hex to the chain's recorded payload. One
   byte off and the test catches it.
5. **Built defensive fallbacks**: if the AtomicHub indexer is down,
   walk the on-chain tables directly (16 parallel chunks). If the
   indexer comes back, use it for speed.
6. **Wired UX guard rails**: pre-flight every claim against the
   per-user `accstats` row so the wallet never signs a transaction
   that's going to revert. Same idea for pack / random-blend flows:
   poll the oracle table before asking for the second signature.

Total cost: a few late-night sessions of reading hex and an
unreasonable number of curl invocations. Total return: a static page
that lets a community keep using their NFTs after the platform walked
away.

---

## --- Run your own copy ---

```bash
git clone https://github.com/<you>/crucible.git
cd crucible
npm install
npm run dev          # localhost:5173 with HMR
```

To publish to **GitHub Pages** (recommended: source and runtime live
at the same commit, easiest possible trust story):

```bash
git push -u origin main
# Then in the repo: Settings -> Pages -> Source: GitHub Actions
```

The included [deploy workflow](.github/workflows/deploy.yml) builds
and publishes on every push to `main`. Your URL becomes
`https://<you>.github.io/<repo>/`.

### Custom domain

```bash
echo "crucible.example.io" > CNAME
git add CNAME && git commit -m "custom domain" && git push
```

Point a DNS CNAME at `<you>.github.io`. HTTPS is provisioned
automatically.

### IPFS mirror

```bash
npm run build
ipfs add -r dist
# Pin the resulting CID via Pinata, Web3.Storage, Filebase, ...
```

Same bundle, no single point of failure.

---

## --- Architecture ---

```
src/
  chain/
    rpc.ts             : APIClient + failover across 4 public WAX RPCs
    session.ts         : WharfKit SessionKit (Anchor + WAX Cloud Wallet)
  nefty/
    abi.ts             : verifies blend.nefty ABI shape at startup
    blend.ts           : reads a blend's recipe, isDeterministic
    discover.ts        : lists blends per collection (indexer + on-chain)
    whitelist.ts       : checks secure.nefty whitelists
    template.ts        : enriches expected mints (name, supply, flags)
    tokens.ts          : token symbol -> contract registry (159 tokens)
    execute.ts         : blend tx (openbal + transfer + nosecfuse)
    rngExecute.ts      : random-blend tx (fuse + claim, with security_check)
    rngWait.ts         : polls claimassets between fuse and claim
    drops.ts           : lists drops per collection + 4 auth flavours
    dropExecute.ts     : claim tx (assertprice + transfer + claim*)
    packs.ts           : lists pack designs (global scan), pairs with wallet
    packExecute.ts     : unbox txs (transfer "unbox" + claimunboxed)
    packWait.ts        : polls unboxassets between TX1 and TX2
    upgrades.ts        : lists up.nefty upgrades per collection
    upgradeExecute.ts  : upgrade tx (openbal + transfer + upgrade)
  waxdao/
    blends.ts          : lists waxdaomarket blends per collection
    blendExecute.ts    : assertblend + slot-indexed transfers
  atomic/
    assets.ts          : lists a user's NFTs from AtomicAssets API
    matcher.ts         : matches blend ingredients to owned NFTs
  ui/
    app.ts             : shell, state, render loop, event wiring
    about.ts           : collapsible in-page guide
    dryrun.ts          : local ABI serialisation, "simulate without signing"
    theme.css          : palette, fonts, scanlines, motion (fork to re-skin)
    layout.css         : page structure, cards, header, footer
    components.css     : pickers, chips, buttons, tabs, pack rows, etc.
scripts/
  verify-trace.mjs             : byte-for-byte for blend traces
  verify-drops.mjs             : byte-for-byte for drop traces
  verify-packs.mjs             : byte-for-byte for pack-unbox traces
  verify-upgrades.mjs          : byte-for-byte for upgrade traces
  verify-waxdao.mjs            : byte-for-byte for waxdaomarket blends
  verify-discover-chain.mjs    : on-chain discovery sanity check
public/
  favicon.svg         : crucible glyph (animated molten core)
  README.md           : user-facing guide (linked in the app footer)
```

---

## --- UX guarantees ---

```
[*] every collection input starts empty -- no auto-load, no stale
    state from a previous session
[*] discovery is on-demand. The user clicks "Discover ..." when they
    want results, never on mount / tab switch / login
[*] re-renders preserve scroll position, focus, and caret offset so
    state changes don't feel like a page refresh
[*] picker dropdowns float ABOVE every card, even the loaded info /
    action zones. The panel is portaled to <body> so it escapes
    backdrop-filter stacking traps
[*] picker rows are sorted by status first (active before everything
    else), then alphabetically by name within each status bucket
[*] every blocker is explained inline. "Greyed" rows say WHY, with a
    "Color codes" legend showing every badge the picker can emit
[*] NFT slots show the human-readable name, not just the template_id.
    Names are resolved from the indexer (best-effort) and cached
    across tab switches
[*] every entity has a shareable hash URL. The address bar updates
    as soon as you pick an entity, and the info card has a one-click
    "share link" button. No wallet required to READ a recipe.
```

---

## --- Limitations ---

Honesty up front:

- **Ownership-secured random blends**: a tiny minority of random
  blends require the user to prove on-chain ownership of a specific
  set of NFTs (`OWNERSHIP_CHECK` security). The current UI sends a
  no-op `WHITELIST_CHECK`, which works for non-secured and
  whitelist-secured random blends but the contract rejects ownership-
  gated ones. A small UI extension would add this.
- **RNG upgrades**: upgrades with non-IMMEDIATE results need the
  `up.nefty/orngjobs` wait + claim flow (same shape as RNG blends).
  Detected and tagged `RNG` in the picker. Adding the flow reuses
  most of `rngWait.ts`.
- **Gated upgrades**: whitelist / ownership-gated `upgradesec` is
  decoded but not yet executable from the UI. Tagged `gated` in the
  picker.
- **NFT-cost upgrades**: upgrades where you also burn NFTs as cost
  (TEMPLATE / SCHEMA / COLLECTION ingredients) are decoded but the
  UI doesn't yet offer a picker for them; only FT-only upgrades are
  signable from v0.4.
- **WaxDAO drops / packs / farms**: only WaxDAO blends are wired up
  today. The rest of the `waxdao*` contract family (drops, farms,
  pack openings on waxdaobacker, etc.) is on the roadmap.
- **`claimdropkey` drops**: cryptographic-key gated drops need a per-
  user pre-signed message from the drop creator. No client can
  fabricate it, fundamentally outside the scope of any third-party
  tool.
- **CPU sponsorship**: Nefty's `neftybrespay` used to pay CPU for
  users. That account no longer signs, so users must stake ~5-10 WAX
  in CPU themselves. Documented in the in-app guide.
- **Other NeftyBlocks contracts** (redemptions, NFT swaps,
  marketplace listings) aren't covered yet. PRs welcome.

---

## --- License & acknowledgements ---

[MIT](LICENSE). Fork it, host it, modify it, ship it. See [NOTICE](NOTICE)
for the "powered by Crucible" attribution we ask forks to keep.

Built on top of, and indebted to:

- **WAX validators** and the Antelope / EOSIO contributors who keep
  the chain humming.
- **[Greymass](https://greymass.com/)** for [WharfKit](https://wharfkit.com/),
  the JavaScript signing stack that makes wallet integration boring
  (in the best way).
- **[Pink.gg](https://pink.gg)** for the AtomicAssets standard and
  the public AtomicHub indexer that survived Nefty.
- **[NeftyBlocks](https://neftyblocks.com)** for `blend.nefty`,
  `neftyblocksd`, `atomicpacksx` and `up.nefty`, and
  **[WaxDAO](https://waxdao.io)** for `waxdaomarket`. The contracts
  outlive the platforms that deployed them. That's exactly what smart
  contracts are supposed to do.

```
> SESSION CLOSE
```
