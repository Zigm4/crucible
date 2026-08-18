```
   ▲ ▲ ▲
    \|/
   ◆ ◆ ◆        C R U C I B L E
    /|\
   ─ ─ ─        on-chain blends · drops · packs · upgrades
                nefty · waxdao · blenderizer
                no website, no backend, no trust required
```

```
> SESSION OPEN

  Nefty.io shut down its UI. WaxDAO's website went dark too, and so
  did 3DkRender's Blenderizer. The smart contracts all three relied
  on are still running on WAX, 24/7, exactly as they were. Crucible
  is the missing client for ALL of them.

  Burn NFTs, claim drops, open packs, mutate NFTs in place, craft
  via WaxDAO or Blenderizer recipes. All directly on-chain, without
  going through any platform that can disappear again.
```

---

## tl;dr

A **static page** with bundled JavaScript (two HTML pages, the app
and a standalone guide; one JS file, one CSS file) that talks straight to eight public WAX smart
contracts (`blend.nefty`, `neftyblocksd`, `neftyblocksp`,
`atomicpacksx`, `up.nefty`, `secure.nefty`, `waxdaomarket`,
`blenderizerx`), plus `atomicassets` for the NFT transfers
themselves. Your wallet signs the
transactions; the page never sees a private key, never phones home,
never stores anything. The blend / drop / upgrade / craft fees that
always existed still go where they always went, nothing comes to me.


```
$ crucible --layout
                                                       wallet
   ┌─────────────────────────────────────────────────────●──┐
   │  [ NEFTYBLOCKS ] [ WAXDAO ] [ BLENDERIZER ]            │  <- platform pills
   ├─────────────────────────────────────────────────────────┤
   │  Blend | Claim | Unpack | Upgrade                       │  <- tabs (per platform)
   └─────────────────────────────────────────────────────────┘
   addressable via hash:  #/nefty/blend/43444
                          #/nefty/claim/237418
                          #/nefty/upgrade/447
                          #/waxdao/blend/1921
                          #/blenderizer/blend/336429
                          #/catalog/underpunks55   <- everything, one page
                          #/status                 <- contract health monitor
                          #/lab                    <- guided creator (unlisted)
```

---

## Contents

**Use it** &middot; [What it does](#what-it-does) &middot; [Shareable links](#shareable-links) &middot; [Limitations](#limitations) &middot; [Themes](#themes)

**Audit it** &middot; [Threat model](#threat-model) &middot; [Privacy](#privacy) &middot; [Verify everything](#verify-everything)

**Fork it** &middot; [Run your own copy](#run-your-own-copy) &middot; [Architecture](#architecture) &middot; [Taking the mechanics out](INTEGRATING.md)

Also here: [the user guide](guide.html) for players, and
[CHANGELOG.md](CHANGELOG.md) for what changed when.

---

<a id="threat-model"></a>

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
| `neftyblocksp` contract     | Its on-chain code         | Same, the second pack contract |
| `secure.nefty` contract     | Its on-chain code         | Same, it enforces whitelist / ownership gates |
| `atomicassets` contract     | Its on-chain code         | Same, every NFT deposit is one of its transfers |
| `up.nefty` contract         | Its on-chain code         | Same |
| `waxdaomarket` contract     | Its on-chain code         | Same |
| `blenderizerx` contract     | Its on-chain code         | Same |
| WharfKit (signing library)  | Greymass + audit-friendly | Open source on GitHub |
| Crucible's front-end        | **You. Read it.**         | This repo + the [verifier scripts](#verify-everything) below |

Remove every Crucible-specific layer from that table and trust only
WAX and the nine contracts above: the worst Crucible can do is *fail
to build the right transaction*. It can't steal funds, drain wallets,
or front-run you. Your wallet shows every action before signing and
would refuse anything weird.

One caveat for collection authors. A create or edit action that is
wrong but still VALID is accepted by the chain rather than reverted,
and then has to be deleted and rebuilt. That is why the blend and
upgrade author flows go through a tick-to-confirm summary of the exact
payload; the older drop panels still use a plain browser `confirm()`.

---

<a id="privacy"></a>

## --- Privacy ---

- no backend, no server, no API key, no database
- no analytics, no telemetry, no Sentry, no Google Tag, nothing
- no cookies. localStorage holds exactly two things, both from code you can delete in one edit: the theme you picked (`crucible-theme`, written by the inline script in index.html) and WharfKit's wallet session (`wharf-*`), so you do not reconnect on every visit. Neither is ever sent anywhere. Log out to drop the session key
- third-party requests are limited to public WAX RPC nodes (chain reads), WAX Hyperion history nodes (`wax.eosphere.io`, `api.waxsweden.org`, used by #/status), the public AtomicAssets indexers (`aa.wax.atomichub.io`, failing over to `wax.api.atomicassets.io` and `aa-wax-public1.neftyblocks.com`) for NFT name enrichment, an IPFS gateway (NFT artwork, see below), and Google Fonts (purely cosmetic, remove in 30s by editing index.html). Clicking "connect wallet" adds that wallet's own hosts: `cb.anchor.link` for Anchor, `*.mycloudwallet.com` for WAX Cloud Wallet
- your private key never leaves your wallet. WharfKit hands the unsigned transaction to Anchor / WAX Cloud Wallet, which signs locally and returns a signature. The page never sees a secret.

**On the IPFS gateway.** Artwork is stored on-chain only as an IPFS
hash, so showing it means asking some gateway for the bytes. That
gateway sees your IP and which NFT you are looking at: the one
third-party request in this app that is about *you* rather than about
the chain. Three mitigations, none of which make it disappear:

- requests carry `referrerpolicy="no-referrer"`, so the gateway never
  learns which page you were on
- the gateway list lives in one constant (`IPFS_GATEWAYS` in
  `src/ui/media.ts`). **Empty it and every IPFS request stops**, same
  escape hatch as the Google Fonts link. One residue: the few templates
  whose image field is already a full `https://` URL are fetched as
  written, so drop the `return [v]` line in `candidatesForRef` as well
  if you want literally zero artwork requests
- nothing is requested until a card that has artwork is actually
  rendered; browsing without opening a blend costs zero image requests

Worth knowing: the obvious gateways are already dead.
`ipfs.atomichub.io` and `atomichub-ipfs.com` have no DNS records at
all, `cloudflare-ipfs.com` no longer resolves to an address, and
`ipfs.neftyblocks.io` now serves a domain-parking page. The same decay that took the websites took their
gateways.

What replaced them matters for coverage: **WAX block-producer gateways
hold WAX NFT media that generic public gateways have never seen**.
`ipfs.eosdac.io` and `ipfs.alienworlds.io` are tried first for exactly
that reason, with `ipfs.io` / `dweb.link` / `w3s.link` /
`gateway.pinata.cloud` behind them for collections pinned outside the
WAX world.

Gateways are also **raced, not queued**. A dead IPFS gateway usually
does not fail, it hangs. So a strict try-then-timeout chain spends the
whole budget on the first stalled host and the artwork looks missing
even when it is perfectly available. Each gateway instead gets a 1.2s
head start before the next joins in parallel, and the first response
that decodes wins.

---

<a id="what-it-does"></a>

## --- What it does ---

### BLEND tab · `blend.nefty`

Every blend Nefty's UI ever submitted was a short action sequence
signed by your wallet. Crucible rebuilds it as 3 actions, or 5 when
tokens are involved, dropping only the `neftybrespay::paycpu` action
whose payer no longer signs:

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

- auto-detects active blends per collection
- reads the live recipe + ingredient list straight from the chain
- checks secure.nefty whitelists before letting you sign
- resolves the token contract from blend.nefty/config/supported_tokens (159 tokens registered as of 2026)
- random blends (fuse + claim, two signatures) with auto-wait between TX1 and TX2 and a full breakdown of the resolved outcome + the in-roll odds
- pool blends (POOL_NFT_RESULT): reward pre-minted into an escrow pool instead of minted on demand, with live pool stock and a "guaranteed" badge when the pool holds a single template

Random blends (any roll with 2+ outcomes) follow:

```
TX 1 - announcedepo + atomicassets::transfer + blend.nefty::fuse
       (the contract either resolves synchronously or queues an
        ORNG job)

       ... wait for claimassets[claimer] to gain a new row ...

TX 2 - blend.nefty::claim  claim_id, roll_indexes
       (mints the resolved cards to your wallet)
```

#### Pool blends · rewards that were minted in advance

A roll can pay out two ways. `ON_DEMAND_NFT_RESULT` mints a fresh NFT
from a template, so the output is known before you sign.
`POOL_NFT_RESULT` doesn't mint anything: the reward NFTs were minted
ahead of time and deposited into a named **pool** on `blend.nefty`, and
the contract hands you one of the assets still escrowed there.

That's how a capped reward stays craftable. Blend 42787
(`underpunks55`, *Volna-57 Geiger Counter*) pays out template 893664,
whose supply is 16/16 already minted. No on-demand mint could ever
produce another one, so all 16 went into the `volna` pool instead.

Because the contract picks *which* escrowed asset you get, the exact
`asset_id` only exists once the claim row is staged. Pool blends
therefore run the same two-step `fuse` → `claim` flow as random blends,
even when the odds leave nothing to chance. Crucible reads the
`pools` / `poolassets` tables and shows what that actually means:

```
GUARANTEED · DRAWN FROM A POOL          <- odds are 1/1, not a lottery
Name:       Volna-57
Source:     pool volna (pool_id 3665) · roll #0
Template:   893664  Volna-57
Pool stock: 9 left (of 16 ever added)

✓ every asset in this pool is template 893664, so the reward NFT is
  certain: only its serial number is drawn
```

A pool holding several templates says so instead, and an empty pool is
called out before you deposit anything.

#### Create a blend · collection authors

`blend.nefty::createblend` is the author-side counterpart to running a
recipe. It is **not on the BLEND tab**: creation lives on the guided
creator below, so there is one path to it rather than two. What follows
is the builder's own one-per-line syntax, which is what the verify suite
replays every real creation through. Its left column is still live: the
ingredient editor in the Manage panel reads and writes exactly this. The
right column is now read-only history, since outcomes cannot be edited
after creation and the guided creator collects them as form state:

```
INGREDIENTS                          OUTCOMES
template 877088 x5                   907173 @50
template 877088 x2 -> vault.wam      907173+906880 @20
template alien.worlds:741859 x1      token 1.00000000 WAX @15
schema up.tools x3 {"description":…} token 5.0000 TLM from alien.worlds @5
attribute up.gear x2 where           pool volna @5
    Rarity = Rare | Epic ;           nothing @5
    Generation = V3
collection x2
token 10.0000 TLM -> payout.wam
```

A blend is a three-level tree (ingredients / weighted outcomes /
results), and a recipe you can read, paste and diff beats a nest of
widgets when what you want is to compare two of them. It is the wrong
thing to hand someone creating their first one, which is why the guided
creator exists.

### How it is verified

`npm run verify:createblend` compiles the real module and replays
**every `createblend` action the chain will serve** through it:

```
10000 creations across 341 collections

PHASE A · encoder      10000/10000 rebuilt to identical bytes
PHASE B · form syntax   9991 round-tripped through the text form,
                           9 reported as not expressible
PHASE C · live rows    every live row across 10 collections rebuildable
                       exactly as they exist today
PHASE D · validation   10000/10000 real recipes accepted by our own
                       validator (any rejection is a false negative)
```

Phase A folds each trace down into the shape the UI works in and
rebuilds it; phase B goes further and renders it into the form's
one-per-line text, parses that back, and demands the same bytes again.
Phase C reads LIVE `blends` rows, covering recipes whose creation
predates the history window. It rebuilds every one of them. Phase D is the mirror image of the others:
every recipe in the corpus was accepted by the contract, so anything
our own validation refuses is a blend an author could not create
through Crucible. It caught a token-precision rule that rejected
zero-decimal assets like `1000000 MSOURCE`, and a JSON check that
refused the 202 real blends whose display_data is not JSON.

The 9 that are not expressible are named, never silently passed: 2
cooldown ingredients (a time gate with no text syntax) and 7 attribute
filters whose names carry significant leading/trailing whitespace,
which the form trims.

Things the builder handles that are easy to get wrong, each found by
diffing against real on-chain creations:

- **NFTs are not always burned.** A steady minority of the NFT
  ingredients across the most recent real creations are *transferred* to a vault
  instead. Assuming "burn" silently destroys NFTs an author meant to
  keep, so `-> account` is explicit and the preview says which is which.
- **Ingredients can come from another collection.** `streamingart`
  recipes mix their own templates with an `alien.worlds` one. Defaulting
  every ingredient to the blend's collection builds the wrong recipe.
- **An outcome may mint nothing.** A blank branch is how authors build
  "you got unlucky"; `waxlandianft`'s 51-outcome blend opens with one at
  20%. Write it as `nothing @20`.
- **An outcome is not always an NFT.** Across the corpus the contract
  also pays out tokens (801 results) and hands over pre-minted NFTs
  from a pool (1,076). Modelling only on-demand mints built a silently
  different recipe for roughly one blend in nine.

`total_odds` is always derived from the weights rather than taken from
the form: the contract does not normalise it, so a hand-entered total
that disagrees with the outcomes silently skews the draw.

The encoder covers every ingredient kind the contract accepts,
cooldown gates included, and the text syntax covers all but those:
multi-attribute filters (`where a = x | y ; b = z`) and per-ingredient
`display_data` round-trip through the ingredient editor and the verify
suite. The guided creator asks for the common subset: one attribute
filter per ingredient, no cooldown, no display_data.

#### Editing after creation

The contract lets an author change nearly everything about a live
blend, and the Manage panel wires most of it: `setblenddata` (used for
the display name only, image and description are preserved untouched),
`setblendtime`, `setblendmax`, `setblendlim`, `setblendhide`,
`setblendsec` (whitelist) and `delblend`. `setblendcat` has a builder
but no control. Upgrades have no equivalent panel: none of `up.nefty`'s
author actions are wired, so an upgrade can be created (at the guided
creator) but not edited or deleted from Crucible.

`setblendmix` (the ingredients) is wired too: the Manage panel offers
an editor pre-filled with the recipe as it stands on chain, because the
action REPLACES the whole list and a blank box would silently drop
everything not retyped. It refuses to open at all for a recipe the text
syntax cannot round-trip, rather than offering a lossy box.

`setrolls` (the outcomes) is deliberately NOT wired, and never will be
from here. The live ABI settles it: `setblendmix` takes
`(authorized_account, blend_id, ingredients)`, `setrolls` takes only
`(blend_id, rolls)`. It is **the one author-looking action with no
account to authorise against**, which makes it a NeftyBlocks
maintenance action; an author's signature is simply rejected. The
history agrees: author-signed `setblendmix` calls run into the
hundreds, while every `setrolls` call that can be found was signed by
NeftyBlocks' own accounts. Changing what a blend PRODUCES therefore means deleting it
and creating a new one: a contract limit, not a missing button.

Every edit of a live blend goes through a **beta confirmation**: an
in-app dialog stating that this flow is new, showing the exact summary
of what is about to be signed, and requiring an explicit tick before
the sign button enables. It is not a browser `confirm()`: it renders
outside `#root` so an app re-render cannot dismiss it mid-decision.
The guided creator carries its own gate, built the same way. The drop
panels on the CLAIM tab predate both and still use a plain browser
`confirm()`, for creating a drop and for every Manage write.

#### Manage panel · collection authors

When the connected wallet is authorized on a blend's collection, the
loaded blend exposes a **Manage** panel (off by default behind a safety
switch). It signs `blend.nefty` author actions one at a time (name,
status, max uses, per-account limit, cooldown, delete), plus full
whitelist management:

- pick any whitelist on the collection from a dropdown (the one gating the current blend is marked "attached")
- see its wallets as chips, add wallets, remove one, or clear all (addtowl / erasefromwl / clearwl)
- create a new whitelist (addwhitelist): this only NAMES an empty list; you then add wallets to it below. The newest list is auto-selected after creation so you can populate it right away
- attach / detach a whitelist to the current blend (setblendsec)

A whitelist (`security_id`) lives on the collection and can gate several
blends at once, so editing its wallets affects all of them. "Attach" is
what gates *this* blend behind the selected list. Naming a list and
filling it with wallets are two separate steps: the name is a label
(e.g. "OG holders"), never a wallet.

### CLAIM tab · drops · `neftyblocksd`

A **drop** is the object an author publishes; **claiming** is what a
player does to it. There is no second concept: the contract has a
`drops` table and a `claimdrop` action. The tab is named after the
action, like Blend, Unpack and Upgrade, and everything inside it is
named after the object.


Drop claims. Same idea, different contract:

```
1. neftyblocksd::assertprice            "Lock this price"
2. <token>::transfer memo=deposit       "Here's the payment"
3. neftyblocksd::<claim variant>        "Claim my drop"
```

Crucible recognises four claim variants and can sign three:

| Variant         | Gate                                          | Action          |
| --------------- | --------------------------------------------- | --------------- |
| Public          | Open to anyone                                | `claimdrop`     |
| Whitelist       | Your account is in `whitelists` table         | `claimdropwl`   |
| NFT proof       | You hold specific NFTs (e.g. 4 templates)     | `claimwproof`   |
| Authkey         | Drop creator pre-signed a per-user message    | *unsupported*, off-chain secret only the creator has |

For free drops, steps 1 and 2 are skipped entirely, only the claim
action is signed.

- drop names resolved from the primary mint template via the AtomicAssets indexer when on-chain display_data is empty, so the picker shows "Triglave Hero" instead of "Drop #237418"
- paid drops: pre-flight balance check per settlement token. If you're eligible but short on tokens, the action card shows the exact top-up needed and disables Sign & claim until you fund your wallet
- NFT-proof drops: even when your wallet doesn't satisfy the rule, the row stays selectable so you can read the requirement in plain English ("hold 1 NFT from template 12345 + 2 NFTs from schema X") and know exactly what to buy

#### Create & manage drops · collection authors

If the connected wallet is authorized on a collection, the CLAIM tab
exposes two opt-in author panels (each behind its own safety toggle).

**Create a drop** (`neftyblocksd::createdrop`) mints a drop from
*existing* templates with the standard options: name / description /
image, templates to mint with per-template quantities, price (or free),
max supply (or unlimited), per-account limit + cooldown, start/end
window, whitelist requirement, hidden, price recipient, credit-card
payments. Touchy options (the minted templates, unlimited/free supply,
the payout account) are boxed in **red** with a plain-language reason;
routine controls keep the calmer amber style.

- free drops encode as "0 NULL" / "0,NULL"; priced drops as "<amount>.<decimals> SYM" / "<decimals>,SYM" (verified against real on-chain drops)
- on success the new drop_id is reported and the drop is auto-loaded into "Manage a drop"

> **Whitelisting is a two-step flow, by contract design.** `createdrop`
> only carries an `auth_required` flag: it takes no account list. The
> allowed accounts live in a separate `whitelists` table keyed by
> `drop_id`, which can only be written *after* the drop exists (you need
> its id). So a drop created with "require whitelist" starts **empty**
> (nobody can claim) until you add accounts in **Manage a drop**. The
> create panel says this, and the drop is loaded there automatically.

**Manage a drop** loads any drop you manage. Pick it from "drops I can
manage" (it lists the drops across the collections you're authorized on,
so you don't need the id), or type a `drop_id` (this works for hidden /
gated drops the claim list hides). From there you can:

- edit the whitelist: add / remove accounts, or clear it (addtowl / erasefromwl), per-drop, scoped by drop_id
- toggle the whitelist requirement (setdropauth)
- hide / unhide (setdrophiddn)
- delete the drop (erasedrop)

Unlike blend whitelists, a drop's whitelist is **per-drop**:
`neftyblocksd` has no reusable named lists, so you add wallets directly
to that drop.

### UNPACK tab · `atomicpacksx` + `neftyblocksp`

Opening a pack is a commit-reveal dance with the ORNG oracle, so it
takes **two wallet signatures** instead of one:

```
TX 1 - atomicassets::transfer  to=<pack contract>, memo="unbox"
       "Take this pack into custody, ask the oracle for randomness."

       ... 5..30 seconds while ORNG calls the contract back ...

TX 2 - <pack contract>::<reveal>   "Randomness is in, mint my cards."
```

Crucible handles **both** pack contracts and merges them into one list:

| Contract        | Reveal action                          | Result staged in            |
| --------------- | -------------------------------------- | --------------------------- |
| `atomicpacksx`  | `claimunboxed(pack_asset_id, origin_roll_ids)` | `unboxassets` (by asset_id) |
| `neftyblocksp`  | `claim(claim_id, roll_indexes)`        | `claimassets` (claim_id == pack asset_id) |

Both are scanned globally; the tab only lists collections where your
wallet currently holds an openable pack (from either contract). You then
pick: collection, pack type, specific mint. Each pack carries its source,
so the right open/claim flow is used automatically.

- cross-collection pack discovery
- auto-wait between TX1 and TX2, with a cancel button if ORNG stalls (your pack stays safe on-chain, resume later)
- full odds breakdown per roll, with resolved template names
- reset and open another mint without re-discovering

### UPGRADE tab · `up.nefty`

The fourth pillar. Upgrades **mutate** existing NFTs you
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

Deterministic upgrades with **FT and/or NFT costs** are fully signable
(the NFT cost picker burns `TEMPLATE` / `SCHEMA` / `COLLECTION`
ingredients, verified against trx `64054c0b…`). Whitelist / ownership
-gated upgrades use `upgradesec` (same shape + a `security_check`
variant); RNG upgrades resolve through `up.nefty/orngjobs`. Both are
decoded and tagged in the picker but not yet executable from the UI -
see [Limitations](#limitations).

- per-collection discovery from up.nefty/upgrades
- active ones first, alphabetical by name inside each status, with status badges (active / sold-out / ended / upcoming / hidden)
- per-spec NFT picker (matches schema + template requirements against your wallet)
- per-ingredient FT balance check
- Simulate serialises the transaction locally against the ABI, so checking a recipe costs no CPU and signs nothing. The upgrade list itself is cached for five minutes; a deep link or a manual id re-reads the row live

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
access it. All three platforms have independent ID spaces, so blend
`#1127` on `blend.nefty` and blend `#1127` on `waxdaomarket` are
totally different recipes.

- per-collection discovery from waxdaomarket/blends
- picker with active / sold-out / ended / upcoming status chips
- per-slot NFT picker filtered by template / schema / collection
- per-slot FT balance check (token contract resolved from the ingredient's own field, no global registry needed)
- one signature for the whole multi-action transaction, byte-for- byte equivalent to a real WaxDAO blend from 2024

### BLENDERIZER tab · `blenderizerx`

A third ecosystem, and **not** a Nefty contract despite doing the same
job: the Blenderizer belongs to **3DkRender** (its own `config` row
credits `3dkrenderwax`) and the account was created **2020-12-03**,
seven months before `blend.nefty`. Its website is gone; the contract
is still live and still used.

It is the simplest of the three by a wide margin:

```
1. atomicassets::transfer  to=blenderizerx
                           memo="<target_template_id>"
                           asset_ids=[every NFT the recipe burns]
```

That's the whole transaction. No announce, no oracle, no claim, no
second signature: the contract reacts to the transfer notification,
mints the target, and burns the deposit in the same transaction.

The recipe table is equally spare, and its **primary key IS the target
template**, so a recipe is addressed by what it produces:

```
blenders   scope = blenderizerx   key = target
  { owner, collection, target: int32, mixture: int32[] }

mixture lists templates to burn WITH repetition, e.g.
  [83, 83, 83, 89, 89, 89]  =  3x template 83 + 3x template 89
```

No odds, no pool, no whitelist, no time window, no token cost.

- per-collection discovery: `blenders` has no index on collection, so Crucible walks all ~17.7K rows in 16 parallel chunks (~3s)
- target templates resolved in one batched indexer call, so the picker shows real names instead of bare ids
- multi-select NFT picker per slot, since amounts are usually >1
- recipe id == target template id: #/blenderizer/blend/336429

Two things stop a recipe paying out, neither visible in the ABI, both
checked before you deposit anything:

- **Sold out.** `blenders` has no supply flag. A capped target that is
  already fully minted simply fails, so Crucible reads issued/max from
  the target template and tags the recipe.
- **No collection RAM.** `blenderizerx` mints from RAM the collection
  author pre-paid (`rambalance`). A collection with no balance fails
  every blend until they top it up; the amount left is shown inline.

### Creating an upgrade

`up.nefty::createupgrde`. Also **not on the UPGRADE tab**: like blends,
creation happens on the guided creator below. An upgrade mints nothing,
it rewrites attributes on an NFT the player already owns, so a recipe has
three parts: the cost, which NFTs qualify, and what changes.

```
COST                          APPLIES TO
token 10.00000000 WAX ->      templates 906678 + 906679
    payout.wam                attribute uint64 level = 1 | 2
template 877088 x1

WHAT CHANGES
name = Upgraded Sword         image img = Qm…
uint64 level += 1             bool engine = true
```

The leading word is the attribute's **declared type on the schema**. It
decides the wire encoding, and getting it wrong is the one mistake the
chain will not catch: exactly why the guided creator reads it from the
schema instead of asking. Verified against every createupgrde on chain,
see the verify section.

### GUIDED CREATOR · `#/lab`  (unlisted)

Nothing links to it: you reach it by knowing the path. It is a **real**
creator and it signs real transactions.

It is also the **only** way to create a blend or an upgrade. Those panels
used to sit on the BLEND and UPGRADE tabs behind a safety toggle; they
were removed rather than kept alongside: two creation paths mean two
sets of mistakes to guard against, and only one of them reads the
schema before writing to it. Editing an existing blend, whitelists, and
drop creation stay on the main page.

```
$ crucible #/lab

  (1) Collection  (2) What players give  (3) What they get  (4) Rules  (5) Review

  > A player gives 5 x Leather Scraps (destroyed) and 10.00000000 WAX paid to
    payout.wam and gets 50% Mycelium Helmet, 30% Pauldrons, 20% nothing.

  [####################|############|########]
   Mycelium Helmet 50%   Pauldrons 30%  nothing 20%
```

The panels it replaced were text boxes with a syntax to learn: template
ids typed from memory, weights as abstract numbers, and for upgrades an
attribute type the author had to DECLARE. This reads the collection
first, so none of that is asked:

- blends (blend.nefty), upgrades (up.nefty) and drops (neftyblocksd), one question per screen, five screens each. Drops can also still be created from the CLAIM tab
- templates picked from a searchable grid with artwork, name, schema and supply, read live from the collection
- weights drawn as a stacked bar, so "50 / 30 / 20" is a shape before it is arithmetic
- one plain sentence on every step. If the sentence is wrong, the recipe is wrong, with no payload to decode
- Simulate before signing, then a confirmation you have to tick
- one roll per blend and one spec per upgrade. The contract allows several of each (a second roll is a second, independent draw paid out on the same blend); that shape has to be built elsewhere
- whitelists are read, not created: the creator offers the collection's existing lists, and a drop it creates with the whitelist flag is still empty, so both finish in the Manage panels on the main page

**The attribute question.** An upgrade's `attribute_type` must match what
the schema declares, and the README's own warning about the classic form
was that getting it wrong is the one mistake the chain will not catch.
Here the type is never typed: the schema `format` is the authority, and
the picker enforces two rules on top of it.

- only the 7 types the encoder actually models are selectable (string image ipfs uint64 double bool uint8). A uint16 attribute would fall through wireTypeFor() to `string` and be written as nonsense, so it is shown disabled with the reason
- an attribute frozen in the immutable_data of EVERY template it would apply to is BLOCKED. Upgrades write mutable_data, and every indexer applies template immutable data last, so the change is stored and nothing anyone sees ever changes: the ingredients burn for nothing
- frozen on only SOME of them is a warning, not a block, saying how many. That distinction is not academic: `kingsburynft/tv` pins `img` on 70 of its 71 templates and its live upgrades rewrite `img` anyway. All 124 upgraded assets belong to the one template that leaves it free. A blanket block would have refused a recipe that demonstrably works

The scope narrows as you restrict. On `underpunks55/up.armour` all 33
templates pin `protection`, so it is blocked outright; `air+` is pinned on
5 of 33 and is offered with the count; name a single template requirement
and the calculation redoes itself against just that template.

`npm run verify:lab` checks all of it: 18 payloads built from form state
and serialised against the LIVE `blend.nefty` / `up.nefty` /
`neftyblocksd` ABIs, 12 recipes that must be rejected and for the stated
reason, and the attribute gate replayed against five real collections,
four of them cross-checked against every attribute their live upgrades
actually rewrite.

Self-contained in `src/ui/lab.ts`: its own state, its own render, its own
confirmation gate, and nothing in the app reads from it. Removing the
page is that file plus its import and route in `app.ts`.

### CATALOGUE · `#/catalog/<collection>`

Every tab above is organised the way the CHAIN is: one per contract,
because that is what you need when you are about to sign. For a player
browsing, that is the wrong axis. They want *boots*, and the boots
might be a blend, a Blenderizer recipe, a drop or a pack, on four
different contracts, with nothing listing them together.

The catalogue inverts it. One collection, seven contracts scanned in
parallel as six sources (both pack contracts feed one badge). Every
result is normalised into one row shape and grouped by **category**
(the schema of the item produced), with a coloured badge per source.
Grouping by contract is one click away.

```
$ crucible #/catalog/underpunks55

  22 Blenderizer   102 Blends   36 Drops   17 Packs   24 Upgrades   7 WaxDAO
  208 entries · 130 available now · 97 your wallet can do right now

  UP.ARMOUR                                                    21
    Magical Mycelium Leather Armour Set   [BLEND]        32 NFTs  ✓ ready
    Mycelium Leather Armour Set           [BLENDERIZER]  10 NFTs  ✓ ready
    Mycelium Leather Cuirass              [BLENDERIZER]  48 NFTs  missing 6× template 316897
  UP.MAGIC                                                     14
    Diya of Fortitude                     [UPGRADE]       1 NFT   ✓ ready
    #5 The Evil Dice of Similarly Evil Death [BLEND]      9 NFTs  ✓ ready
```

- six sources scanned concurrently; one failing contract degrades to a warning line instead of taking the page down
- categories resolved from the produced template's schema in batched indexer calls (one call per 100 entries)
- wallet-aware: entries your NFTs satisfy are marked "ready" and sorted first; the rest say what you're missing, by template
- search, group-by toggle, "only what I can do", collapsible groups
- read-only. Every row deep-links back into the normal tab, which still does all the signing: no second transaction implementation

---

<a id="shareable-links"></a>

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

- one-click "share link" button in every info card (zone 3) copies the current URL to the clipboard
- no history pollution: hash writes use replaceState so the back button never gets clogged with intermediate states
- hash changes work in reverse: pasting / typing one of the URLs above into the address bar triggers the same auto-load
- no wallet required to READ a recipe, only to sign it

---

<a id="verify-everything"></a>

## --- Verify everything ---

This is the strongest argument against trusting me. Standalone
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
   ✓ underpunks55::transfer
   ✓ blend.nefty::announcedepo
   ✓ atomicassets::transfer
   ✓ blend.nefty::nosecfuse
```

```bash
$ npm run verify:lab
=== PHASE A/B - build, serialise against the live ABI, validate ===
   ok  blend.nefty::createblend   four-way lottery with token, pool and blank branches
   ok  up.nefty::createupgrde     a bool writes the NUMBER 1, not true
   ok  neftyblocksd::createdrop   paid in TLM keeps four decimals
   ok  REJECTED  an attribute frozen on EVERY template
   18 payload(s) serialised, 14 shape check(s), 12 correct rejection(s)

=== PHASE C - the schema gate, against real collections ===
   ok  kingsburynft/tv: 8 attribute(s), 71 template(s), 7 rewritable
       3 attribute(s) rewritten by real upgrades, all allowed
```

```bash
$ node scripts/verify-pool-blend.mjs
=== blend 42787 "Volna-57 Geiger Counter" ===
   ✓ blend declares a POOL_NFT_RESULT  pool="volna"
   ✓ odds are certain (1 outcome at full total_odds per roll)
   ✓ pools.count matches the escrowed asset_ids  9 == 9
   ✓ pool hands out a single template  [893664]
   ✓ result template is capped and fully minted (hence the pool)
   ✓ blend.nefty::announcedepo / atomicassets::transfer
     / blend.nefty::fuse  serialise against the live ABIs
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
$ node scripts/verify-blenderizer.mjs
=== recipe 106051 (niftywizards) ===
   ✓ config.author is 3dkrenderwax (3DkRender, NOT NeftyBlocks)
   ✓ primary key IS the target template_id
   ✓ slot amounts match the trace asset count  11 == 11
   ✓ 10x template 362363 + 1x template 20562 deposited
   ✓ the whole blend is ONE transfer (no announce, no 2nd signature)
   ✓ atomicassets::transfer matches the trace byte for byte
   ✓ discovery finds it by scanning 17748 rows (18 calls, ~4s)
```

```bash
$ node scripts/verify-discover-chain.mjs
# Walks ~33K rows of blend.nefty/blends in parallel chunks of 5,000
# blend_ids (10 chunks at today's table head, capped at 16).
# (~5 seconds). Confirms every Underpunks blend is reachable
# on-chain and that two specific reference blends appear.
```

Translation: I didn't write the action structures from memory or a
spec PDF. I pulled real transactions from a user's own on-chain
history (thanks zigm4.gm), decoded each action's parameters, then
wrote a builder that reproduces them. The proof is in `scripts/`,
re-run it whenever you doubt me.

---

<a id="how-this-was-built"></a>

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
   walk the on-chain tables directly (parallel chunks of 5,000
   blend_ids, capped at 16 chunks). If the
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

<a id="run-your-own-copy"></a>

## --- Run your own copy ---

```bash
git clone https://github.com/<you>/crucible.git
cd crucible
npm install
npm run dev          # localhost:5173 with HMR
npm run build        # tsc --noEmit + vite build -> dist/
npm run preview      # serve the built dist/ locally
npm run build:verify # compile the author-side builders for the verify scripts
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

Same bundle, no single point of failure. The build is multi-page:
`dist/index.html` (the app) and `dist/guide.html` (the user guide),
plus everything under `public/`.

---

<a id="architecture"></a>

## --- Architecture ---

```
index.html            : app shell (loads src/main.ts + src/ui/style.css)
guide.html            : standalone themed user guide, 2nd Vite build input
                        (vite.config.ts rollupOptions.input.guide)
src/
  main.ts              : entry point - hands off to ui/app::mount(),
                         renders a fail-safe error card if mount throws
  chain/
    action.ts          : BuiltAction, the one shape every builder emits
    rpc.ts             : APIClient + failover across 4 public WAX RPCs,
                         per-request timeouts so a hung host can't stall
    session.ts         : WharfKit SessionKit (Anchor + WAX Cloud Wallet)
    index.ts           : the facade for this folder
  nefty/
    index.ts           : the facade, grouped by mechanic. Says what each
                         one needs at minimum. See INTEGRATING.md
    abi.ts             : verifies blend.nefty ABI shape at startup
    blend.ts           : reads a blend's recipe, isDeterministic
    pools.ts           : reads blend.nefty pools + escrowed asset_ids
                         (POOL_NFT_RESULT rewards)
    discover.ts        : lists blends per collection (indexer + on-chain)
    whitelist.ts       : checks secure.nefty whitelists
    admin.ts           : author actions - blend settings + secure.nefty
                         whitelists (the BLEND Manage panel)
    template.ts        : enriches expected mints (name, supply, flags)
    tokens.ts          : token symbol -> contract registry (159 tokens)
    execute.ts         : blend tx (openbal + transfer + nosecfuse)
    rngExecute.ts      : random-blend tx (fuse + claim, with security_check)
    rngWait.ts         : polls claimassets between fuse and claim
    drops.ts           : lists drops per collection + 4 auth flavours
    dropExecute.ts     : claim tx (assertprice + transfer + claim*)
    createBlend.ts     : author action - build a createblend tx
                         (+ the form's ingredient/outcome parsers,
                          shared with createUpgrade)
    createUpgrade.ts   : author action - build a createupgrde tx
                         (+ the requirement/rewrite parsers)
    createDrop.ts      : author action - build a createdrop tx
    dropAdmin.ts       : author actions - drop whitelist + settings + reads
    packs.ts           : lists atomicpacksx pack designs, pairs with wallet
    packExecute.ts     : atomicpacksx unbox txs (transfer + claimunboxed)
    packWait.ts        : polls unboxassets between TX1 and TX2
    neftyPacks.ts      : lists neftyblocksp (NeftyBlocks) pack designs
    neftyPackExecute.ts: neftyblocksp unbox txs (transfer + claim)
    neftyPackWait.ts   : polls neftyblocksp claimassets between TX1 and TX2
    upgrades.ts        : lists up.nefty upgrades per collection
    upgradeExecute.ts  : upgrade tx (openbal + transfer + upgrade)
  blenderizer/
    blends.ts          : lists blenderizerx recipes per collection
                         (full-table scan + target template enrichment)
    blendExecute.ts    : blenderizerx blend tx (a single transfer)
    index.ts           : the facade for this folder
  waxdao/
    blends.ts          : lists waxdaomarket blends per collection
    blendExecute.ts    : assertblend + slot-indexed transfers
    index.ts           : the facade for this folder
  atomic/
    assets.ts          : lists a user's NFTs from AtomicAssets API
    matcher.ts         : matches blend ingredients to owned NFTs
    collections.ts     : collection auth (can this wallet manage it?) +
                         lists collections a wallet is authorized on
    image.ts           : where a template keeps its artwork reference
    index.ts           : the facade for this folder
  ui/
    app.ts             : shell, state, render loop, event wiring
    about.ts           : collapsible in-page guide
    catalog.ts         : #/catalog - one collection across all seven
                         contracts (six scan sources, the two pack
                         contracts share one), grouped by category
    media.ts           : IPFS resolution + non-distorting thumbnails
                         (gateway fallback, removes itself on failure)
    lab.ts             : #/lab - unlisted guided creator for blends,
                         upgrades and drops (reads schemas, signs)
    status.ts          : #/status - contract health monitor
    dryrun.ts          : local ABI serialisation, "simulate without signing"
    style.css          : entry point - @imports the five files below in order
    theme.css          : default "cyber" skin: palette, fonts, scanlines,
                         motion (fork this to re-skin)
    layout.css         : page structure, cards, header, footer
    components.css     : pickers, chips, buttons, tabs, pack rows, etc.
    neutral.css        : "Clair" light theme (data-theme="neutral")
    modern.css         : "Sombre" dark theme (data-theme="modern", the default)
scripts/
  verify-trace.mjs             : byte-for-byte for blend traces
  verify-drops.mjs             : byte-for-byte for drop traces
  verify-packs.mjs             : byte-for-byte for pack-unbox traces
  verify-upgrades.mjs          : byte-for-byte for upgrade traces
  verify-waxdao.mjs            : byte-for-byte for waxdaomarket blends
  verify-blenderizer.mjs       : byte-for-byte for blenderizerx blends
  verify-admin.mjs             : byte-for-byte for the 10 author/admin
                                 actions (blend settings + secure.nefty)
  verify-createblend.mjs       : byte-for-byte for createblend across
                                 every creation on chain + the parsers
  verify-createupgrade.mjs     : the same, for createupgrde
                                 (both need `npm run build:verify` first,
                                  which their npm scripts run for you)
  verify-lab.mjs               : the #/lab creator: form state -> args ->
                                 live ABI, plus the attribute gate against
                                 five real collections
  verify-pool-blend.mjs        : POOL_NFT blend path against chain state
  verify-discover-chain.mjs    : on-chain discovery sanity check
public/
  favicon.svg         : crucible glyph (animated molten core)
```

---

<a id="ux-guarantees"></a>

## --- UX guarantees ---

Rules the app holds itself to, that you will not find stated in the
sections above.

- re-renders preserve scroll position, focus, and caret offset, so a state change never feels like a page refresh
- picker dropdowns float above every card. The panel is portaled to `<body>` so it escapes `backdrop-filter` stacking traps
- every blocker is explained inline. A greyed row says WHY, and a "Color codes" legend shows every badge the picker can emit
- action outcomes pop a floating toast that is visible wherever you have scrolled, so a transaction fired from a panel low on the page still confirms clearly

---

<a id="themes"></a>

## --- Themes ---

Three built-in skins, switched from the toggle in the top-right corner
and remembered across visits (`localStorage`, still no cookies):

- **Sombre.** The default. A calm, modern dark theme: graphite
  surfaces, a soft violet accent, rounded cards, no chrome.
- **Clair.** A clean light theme for bright environments.
- **Neon.** The original cyberpunk skin (scanlines, neon cyan, mono).

It's all CSS, living in `src/ui/neutral.css` and `src/ui/modern.css`,
scoped under `html[data-theme=…]`; the base stylesheets stay untouched
and a first-time visitor lands on **Sombre**. To re-skin or add a fourth
theme, copy the pattern in those files. No application code is involved.

---

<a id="limitations"></a>

## --- Limitations ---

Honesty up front. Grouped by *why* each one isn't done, so you know
which are a few hours of UI work and which are impossible by design.

### Builder is ready, only the UI is missing

For these, the transaction builder already emits the exact on-chain
shape, proven against real traces (trx ids given). What's missing is
the front-end wiring, so they're the highest-value things to add next.

- **Ownership-secured blends.** Random blends gated by `OWNERSHIP_CHECK`
  ask you to prove you *hold* a specific NFT (which is **not** burned).
  Not an edge case: every one of the 40 most recent `blend.nefty::fuse`
  actions is ownership-gated. `rngExecute.ts` already encodes `OWNERSHIP_CHECK`,
  but the UI still sends only the no-op `WHITELIST_CHECK` and can't tell
  an ownership gate from a whitelist gate, so an ownership blend today
  shows a misleading *"not on the whitelist"* message. To finish: read
  the `secure.nefty/proofown` rule, show a proof-NFT picker, pass the
  `asset_ids`. Traces: `e9720eaf…` (blend 36262), `432629ce…` (blend
  30186).
- **Gated upgrades** (`up.nefty::upgradesec`). Whitelist- and
  ownership-gated upgrades. `buildUpgradeActions` already emits
  `upgradesec` with the right `security_check`; the UI blocks them.
  Whitelist is the easy half (reuse the blend whitelist check); ownership
  reuses the same proof-NFT picker as above. Traces: `64054c0b…`
  (whitelist, upgrade 37), `b5aa7b89…` (ownership, upgrade 994).
- **RNG upgrades.** Upgrades whose result the oracle decides. Important
  correction: `up.nefty` has **no `claim` action**. Unlike RNG *blends*,
  there is no second signature. You sign the same `upgrade` /
  `upgradesec` action and the ORNG callback rewrites the NFT's
  `mutable_data` a few seconds later (a row in `up.nefty/orngjobs`
  tracks the pending job). The UI only needs to stop blocking
  `is_random` and show a short "applying…" wait. Tagged `RNG` in the
  picker today.

### Partial coverage (common cases work, exotic variants don't)

- **Exotic blend ingredients.** `BALANCE_INGREDIENT` (chest/balance) and
  `COOLDOWN_INGREDIENT` blends are decoded but flagged `UNSUPPORTED` by
  the matcher. Signable ingredient kinds: TEMPLATE, SCHEMA, ATTRIBUTE,
  COLLECTION, FT.
- **Exotic upgrade costs.** FT plus NFT (TEMPLATE / SCHEMA / COLLECTION)
  costs are signable. `BALANCE`, `ATTRIBUTE` and `TYPED_ATTRIBUTE` costs
  are decoded but not pickable yet.
- **Attribute-targeted upgrades.** Upgrade specs that select which NFTs
  you can upgrade by *attribute* (rather than by template) aren't
  matched yet; only `template` / `templates` requirements feed the
  picker.

### Out of scope by design, or external

- **`claimdropkey` drops.** Cryptographic-key gated: the creator must
  sign a per-user message off-chain. No third-party client can fabricate
  it. Genuinely impossible, not a TODO.
- **CPU.** Nefty's `neftybrespay` used to pay CPU for users; that account
  no longer signs, so you stake ~5-10 WAX of CPU yourself (or sign with
  WAX Cloud Wallet). External to this tool. If the wallet falls back to a
  resource provider (Greymass Fuel) that doesn't cosign, the chain
  rejects with *"declares authority greymassfuel@cosign … does not have
  signatures for it"*. Staking CPU avoids it. The in-app guide explains
  this.

### On the roadmap

**Next, in order.** Both came out of tester feedback on the guided
creator.

1. **Pick the token from the chain's own list.** A priced drop currently
   offers three hardcoded tokens and asks the author to type the number
   of decimals. `neftyblocksd/config.supported_tokens` already carries
   162 entries as `{token_contract, token_symbol}`, and the symbol holds
   the precision (`4,DUST`). Read that list, drop the decimals field.
   Typing 8 decimals for a 4-decimal token is a silent factor of 10,000
   that the contract accepts without complaint.
2. **Editing, at `#/lab`.** The guided creator can create a blend, an
   upgrade and a drop, but not change one afterwards. Editing lives on
   the main page, in a text box, for blends only. Everything the three
   contracts allow an author to change (`setblend*`, `setupgrd*`,
   `setdrop*`) should be reachable from the same guided screen that
   created it. Note the asymmetry to resolve on the way: `up.nefty` has
   a full `setupgrd*` family that Crucible wires nowhere, so an upgrade
   can be created and then never touched again.

Then:

- **WaxDAO drops / packs / farms.** Only WaxDAO *blends* are wired today.
  The rest of the `waxdao*` family (drops, farms, pack openings on
  waxdaobacker, etc.) follows the same ABI-driven method.
- **Creating templates / schemas.** Drops mint from templates that
  already exist. Making new templates/schemas (irreversible, riskier)
  isn't in the app yet. Create them on AtomicHub, then build the drop
  here.
- **Other NeftyBlocks contracts** (redemptions, NFT swaps, marketplace
  listings) aren't covered yet, beyond the read-only health cards on
  #/status. PRs welcome.

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
- **[pink.network](https://pink.network)** for the AtomicAssets standard and
  the public AtomicHub indexer that survived Nefty.
- **[NeftyBlocks](https://neftyblocks.com)** for `blend.nefty`,
  `neftyblocksd`, `neftyblocksp`, `up.nefty` and `secure.nefty`,
  **[WaxDAO](https://waxdao.io)** for `waxdaomarket`, and
  **3DkRender** for `blenderizerx`. Packs also lean on AtomicHub's
  `atomicpacksx`, which is pink.network's contract, not NeftyBlocks'.
  The contracts outlive the platforms that deployed them. That's
  exactly what smart contracts are supposed to do.

```
> SESSION CLOSE
```
