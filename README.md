```
   ▲ ▲ ▲
    \|/
   ◆ ◆ ◆        C R U C I B L E
    /|\
   ─ ─ ─        on-chain blends · on-chain drops · on-chain packs
                no website, no backend, no trust required
```

> `> SESSION OPEN`
> `> Nefty.io shut down its UI. The smart contracts it wrapped are still`
> `> running on WAX, 24/7, exactly as they were. Crucible is the missing`
> `> client. Burn NFTs, claim drops, open packs, mint things, directly`
> `> on-chain, without going through any platform that can disappear`
> `> again.`

---

## tl;dr

A **single HTML file** with bundled JavaScript that talks straight to
three public WAX smart contracts (`blend.nefty`, `neftyblocksd`,
`atomicpacksx`). Your wallet signs the transactions; the page never sees
a private key, never phones home, never stores anything. The blend fees
and drop fees that always existed still go where they always went,
nothing comes to me.

```
$ crucible --status
contracts.............. blend.nefty + neftyblocksd + atomicpacksx  [LIVE]
backend................ none                                       [BY DESIGN]
telemetry.............. none                                       [BY DESIGN]
cookies................ none                                       [BY DESIGN]
service charge......... 0 %                                        [GUARANTEED]
audit...................... open source                            [GO READ IT]
```

---

## ── Threat model · what you should trust ─────────────────────────────

Crucible's whole point is to **remove people from the trust path**.
You shouldn't have to trust me, my hosting, my domain, my email. The
only thing you should trust is the smart contract code itself, which is
the same code that has been running for years and that the chain enforces
byte-for-byte.

| Layer                       | Who you trust            | How to verify |
| --------------------------- | ------------------------ | ------------- |
| The WAX chain               | The WAX validators        | Use multiple RPCs (the app already does failover) |
| `blend.nefty` contract      | Its on-chain code         | `cleos get code blend.nefty`, unchanged since 2024 |
| `neftyblocksd` contract     | Its on-chain code         | Same |
| `atomicpacksx` contract     | Its on-chain code         | Same, plus the ORNG oracle |
| WharfKit (signing library)  | Greymass + audit-friendly | Open source on GitHub |
| Crucible's front-end        | **You. Read it.**         | This repo + the [verifier scripts](#-verify-everything-) below |

If you remove every Crucible-specific layer from that table and trust
only WAX and the three contracts above, the worst Crucible can do is
*fail to build the right transaction*. It can't steal funds, drain
wallets, or front-run you. Your wallet shows every action before signing
and would refuse anything weird.

---

## ── Privacy · what the app does NOT do ───────────────────────────────

- **No backend**, no server, no API key, no database. It's an HTML file.
- **No analytics, no telemetry**, no Sentry, no Google Tag, nothing.
- **No cookies**, no localStorage tracking. (One key in localStorage:
  the collection you last picked, so the dropdown remembers it. That's
  it.)
- **No third-party requests** except to public WAX RPC nodes (for chain
  reads), AtomicHub's public AtomicAssets API (to enrich NFT names), and
  Google Fonts for the monospace face. That last one is purely cosmetic
  and can be removed in 30 seconds by editing `index.html`.
- **Your private key never leaves your wallet**. WharfKit hands the
  unsigned transaction to Anchor / WAX Cloud Wallet, which signs locally
  and returns a signature. The page never sees a secret.

---

## ── What it actually does ────────────────────────────────────────────

### BLEND tab · `blend.nefty`

Every blend Nefty's UI ever submitted was a 3 or 5 action transaction
signed by your wallet. Crucible builds the same thing:

```
1. blend.nefty::announcedepo            "I'm depositing N NFTs"
2. atomicassets::transfer  memo deposit  "Here are the N NFTs"
3. blend.nefty::nosecfuse                "Burn them, mint my result"
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
[*] random blends (fuse + claim, two signatures) supported with
    auto-wait between TX1 and TX2 and a full breakdown of the
    resolved outcome + the in-roll odds
```

For random blends (any roll with 2+ possible outcomes), the flow becomes:

```
TX 1 - blend.nefty::announcedepo + atomicassets::transfer + blend.nefty::fuse
       (the contract either resolves synchronously or queues an ORNG job)

       ... wait for claimassets[claimer] to gain a new row ...

TX 2 - blend.nefty::claim  claim_id, roll_indexes
       (mints the resolved cards to your wallet)
```

Crucible auto-waits between the two signatures, exactly like the UNPACK
flow, and shows you which outcome the contract picked plus its
probability before you sign step 2.

### CLAIM tab · `neftyblocksd`

Drop claims are the second pillar of what Nefty did. Same idea, different
contract:

```
1. neftyblocksd::assertprice            "Lock this price"
2. <token>::transfer  memo deposit       "Here's the payment"
3. neftyblocksd::<claim variant>         "Claim my drop"
```

Crucible handles four claim variants:

| Variant         | Gate                                          | Action          |
| --------------- | --------------------------------------------- | --------------- |
| Public          | Open to anyone                                | `claimdrop`     |
| Whitelist       | Your account is in `whitelists` table         | `claimdropwl`   |
| NFT proof       | You hold specific NFTs (e.g. 4 templates)     | `claimwproof`   |
| Authkey         | Drop creator pre-signed a per-user message    | *unsupported*, needs an off-chain secret only the creator has |

Crucible checks `proofown` rules, auto-picks the matching NFTs from your
wallet, and tracks per-account claim limits (`account_limit` and
`account_limit_cooldown`) so you don't waste CPU on a doomed transaction.

For free drops, steps 1 and 2 are skipped entirely, only the claim
action is signed.

```
[*] drop names resolved from the primary mint template via the
    AtomicAssets indexer when on-chain display_data is empty, so the
    picker shows "Triglave Hero" instead of "Drop #237418"
[*] paid drops: pre-flight balance check per settlement token. If
    you're eligible but short on tokens, the action card shows the
    exact top-up needed and disables Sign & claim until you fund
    your wallet
[*] NFT-proof drops: even when your wallet doesn't satisfy the rule,
    the row stays selectable so you can see the requirement in plain
    English ("hold 1 NFT from template 12345 + 2 NFTs from schema X")
    and know exactly what to buy
```

### UNPACK tab · `atomicpacksx`

The third pillar. Opening a pack is a commit-reveal dance with the ORNG
oracle, so it takes **two wallet signatures** instead of one:

```
TX 1 ─ atomicassets::transfer  to=atomicpacksx, memo="unbox"
       "Take this pack into custody and ask the oracle for randomness."

       ... 5 to 30 seconds while ORNG calls the contract back ...

TX 2 ─ atomicpacksx::claimunboxed  pack_asset_id, origin_roll_ids
       "Randomness is in, mint my cards."
```

Crucible auto-waits between the two signatures: after TX1 broadcasts,
it polls the `unboxassets` table every 2 seconds until the oracle row
appears, then prompts you for TX2. No browser tab refresh, no manual
copy-paste of asset IDs.

The same contract handles every collection on WAX. Crucible scans
`atomicpacksx` globally and only lists collections where your wallet
currently holds at least one openable pack. You then pick: collection,
pack type, specific mint (when you own more than one of the same).

```
[*] cross-collection pack discovery: one click lists every pack you own
[*] auto-wait between TX1 and TX2, with a cancel button if ORNG stalls
[*] full odds breakdown per roll, with resolved template names
[*] reset and open another mint without re-discovering
```

---

## ── Verify everything ────────────────────────────────────────────────

This is the strongest argument against trusting me. Four standalone
Node scripts reconstruct real historical transactions from the chain and
prove the action payloads our code generates match what was actually
signed, **byte for byte**. If something in this codebase ever produces
a different binary, the scripts fail loudly.

```bash
$ node scripts/verify-trace.mjs
=== NFT-only blend 43444 (trx ef67da1e...) ===
   ✓ blend.nefty::announcedepo
   ✓ atomicassets::transfer
   ✓ blend.nefty::nosecfuse

=== Token blend 43802 (trx df21bb22...) ===
   ✓ blend.nefty::openbal
   ✓ underpunks55::transfer  (105.00000000 UPMAX)
   ✓ blend.nefty::announcedepo
   ✓ atomicassets::transfer
   ✓ blend.nefty::nosecfuse

=== ALL TRACES MATCH ===
```

```bash
$ node scripts/verify-drops.mjs
=== Drop 237418 · claimdrop (paid 50 WAX) ===
   ✓ neftyblocksd::assertprice
   ✓ eosio.token::transfer
   ✓ neftyblocksd::claimdrop

=== Drop 237297 · claimwproof (paid 10000 GUILD, NFT proof) ===
   ✓ neftyblocksd::assertprice
   ✓ foundry.tag::transfer
   ✓ neftyblocksd::claimwproof  (with 4 ownership-proof asset_ids)

=== ALL DROP TRACES MATCH ===
```

```bash
$ node scripts/verify-packs.mjs
=== Pack unbox (zigm4.gm, pack 1099968251815) ===
   ✓ atomicassets::transfer       (TX1, memo "unbox")
   ✓ atomicpacksx::claimunboxed   (TX2, with origin_roll_ids)

=== ALL PACK ACTIONS MATCH THE ORIGINAL TRACES ===
```

```bash
$ node scripts/verify-discover-chain.mjs
# Walks ~30K+ rows of blend.nefty/blends in 16 parallel chunks (~5 seconds).
# Confirms every Underpunks blend is reachable on-chain and that two
# specific reference blends (#43444, #43802) appear in the output.
```

Translation: I didn't write the action structures from memory or from a
spec PDF. I pulled real transactions from a user's own on-chain history
(thanks zigm4.gm), decoded each action's parameters, then wrote a builder
that reproduces them. The proof is in `scripts/`, re-run it whenever
you doubt me.

---

## ── How this was built ───────────────────────────────────────────────

Short version, in case you're curious about the process, or want to
fork and do the same for another defunct platform.

1. **Pulled live ABIs** for the three contracts via
   `/v1/chain/get_abi`. The ABI is the contract's self-description: every
   table, every action, every struct. No documentation needed, the chain
   is the documentation.
2. **Decoded historical transactions** from a wallet that had used the
   old UI. Hyperion's `/v2/history/get_transaction` reveals every action
   with its parameters. Cross-referenced these against the ABI to
   understand each field's role.
3. **Re-implemented the action builders** purely against the ABI. The
   serialization is done locally by WharfKit's `Action.from(...)`,
   no remote `abi_json_to_bin` call (most public RPCs disable it
   anyway).
4. **Verified equivalence**: for each historical transaction, encode our
   actions and compare the resulting hex to the chain's recorded payload.
   When a single byte differs, the test catches it.
5. **Built defensive fallbacks**: if the AtomicHub indexer is down, walk
   the on-chain tables directly (16 parallel chunks for blends, drops,
   and packs). If the indexer comes back, use it for speed.
6. **Wired UX guard rails**: pre-flight every claim against the per-user
   `accstats` row so the wallet never has to sign a transaction that's
   going to revert. Same idea for pack openings: poll the oracle table
   before asking for the second signature.

Total cost so far: a few late-night sessions of reading hex and an
unreasonable number of curl invocations. Total return: a small static
page that lets a community keep using their NFTs after the platform
walked away.

---

## ── Run your own copy ────────────────────────────────────────────────

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
# Then in the repo: Settings → Pages → Source: GitHub Actions
```

The included [deploy workflow](.github/workflows/deploy.yml) builds and
publishes on every push to `main`. Your URL becomes
`https://<you>.github.io/<repo>/`.

### Custom domain

```bash
echo "crucible.example.io" > CNAME
git add CNAME && git commit -m "custom domain" && git push
```

Then point a DNS CNAME at `<you>.github.io`. HTTPS is provisioned
automatically.

### IPFS mirror (decentralised distribution)

```bash
npm run build
ipfs add -r dist
# Pin the resulting CID via Pinata, Web3.Storage, Filebase, ...
```

Same bundle, no single point of failure.

---

## ── Architecture (one screen) ────────────────────────────────────────

```
src/
  chain/
    rpc.ts            : APIClient + failover across 4 public WAX RPCs
    session.ts        : WharfKit SessionKit (Anchor + WAX Cloud Wallet)
  nefty/
    abi.ts            : verifies blend.nefty ABI shape at startup
    blend.ts          : reads a blend's recipe, predicate isDeterministic
    discover.ts       : lists blends per collection (indexer + on-chain fallback)
    whitelist.ts      : checks secure.nefty whitelists
    template.ts       : enriches expected mints (name, supply, flags)
    tokens.ts         : token symbol -> contract registry (159 tokens)
    execute.ts        : builds the blend tx (openbal + transfer + nosecfuse)
    drops.ts          : lists drops per collection + resolves 4 auth flavours
    dropExecute.ts    : builds the claim tx (assertprice + transfer + claim*)
    packs.ts          : lists pack designs (global scan), pairs with wallet inventory
    packExecute.ts    : builds the unbox txs (transfer "unbox" + claimunboxed)
    packWait.ts       : polls unboxassets for the ORNG callback between TX1 and TX2
  atomic/
    assets.ts         : lists a user's NFTs from AtomicAssets API
    matcher.ts        : matches blend ingredients to owned NFTs
  ui/
    app.ts            : shell, state, render loop, event wiring
    about.ts          : collapsible in-page guide
    dryrun.ts         : local ABI serialisation, "simulate without signing"
    theme.css         : palette, fonts, scanlines, motion (fork this for re-skins)
    layout.css        : page structure, cards, header, footer
    components.css    : pickers, chips, buttons, tabs, pack rows
scripts/
  verify-trace.mjs           : byte-for-byte verifier for blend traces
  verify-drops.mjs           : byte-for-byte verifier for drop traces
  verify-packs.mjs           : byte-for-byte verifier for pack-unbox traces
  verify-discover-chain.mjs  : on-chain discovery sanity check
public/
  favicon.svg         : crucible glyph (animated molten core)
  README.md           : user-facing guide (linked in the app footer)
```

---

## ── Limitations · what's NOT here ────────────────────────────────────

Honesty up front:

- **Ownership-secured random blends**: a tiny minority of random
  blends require the user to prove on-chain ownership of a specific
  set of NFTs (`OWNERSHIP_CHECK` security). The current UI sends a
  no-op `WHITELIST_CHECK` payload, which works for non-secured and
  whitelist-secured random blends but is rejected by the contract for
  ownership-gated ones. The picker tags these blends; supporting them
  is a small UI extension on top of the existing flow.
- **`claimdropkey` drops** (cryptographic-key gated) need a per-user
  pre-signed message from the drop creator. No client can fabricate
  that, fundamentally outside the scope of any third-party tool.
- **CPU sponsorship**: Nefty's `neftybrespay` used to pay CPU for users.
  That account no longer signs, so users must stake ~5 to 10 WAX in CPU
  themselves. Documented in the in-app guide.
- **Other NeftyBlocks contracts** (redemptions, NFT swaps, marketplace
  listings) aren't covered yet. PRs welcome.

---

## ── License & acknowledgements ──────────────────────────────────────

[MIT](LICENSE). Fork it, host it, modify it, ship it. See [NOTICE](NOTICE)
for the "powered by Crucible" attribution we ask forks to keep.

Built on top of, and indebted to:

- **WAX validators** and the Antelope / EOSIO contributors who keep the
  chain humming.
- **[Greymass](https://greymass.com/)** for [WharfKit](https://wharfkit.com/), the JavaScript signing stack
  that makes wallet integration boring (in the best way).
- **[Pink.gg](https://pink.gg)** for the AtomicAssets standard and the
  public AtomicHub indexer that survived Nefty.
- **[NeftyBlocks](https://neftyblocks.com)** for `blend.nefty`,
  `neftyblocksd`, and `atomicpacksx`. The contracts outlive the
  platform that deployed them. That's exactly what smart contracts are
  supposed to do.

```
> SESSION CLOSE
```
