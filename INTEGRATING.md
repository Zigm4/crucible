# Taking the mechanics out of Crucible

Crucible is a UI, but almost none of it is. The contract logic lives in
folders that never touch the DOM, run unchanged in Node, and can be
lifted out one at a time.

This file is for you if you want to run NeftyBlocks blends, drops, packs
or upgrades from your own project, or if you just want to understand how
these contracts expect to be called. If you only want to *use* the app,
read [the user guide](./guide.html) instead.

---

## The pattern, once

Every mechanic in this project is two functions:

```ts
buildXActions(args): BuiltAction[]     // pure. no network writes, no wallet, no DOM
executeX(session, args)                // hands that array to a wallet
```

`BuiltAction` ([`src/chain/action.ts`](src/chain/action.ts)) is the only
shape any of them produce:

```ts
interface BuiltAction {
  account: string;                                        // 'blend.nefty'
  name: string;                                           // 'nosecfuse'
  authorization: { actor: string; permission: string }[];
  data: Record<string, unknown>;                          // keyed by ABI FIELD NAMES
}
```

That split is the whole reason this code is portable. The builders decide
what the chain is asked to do; they never decide who signs, how, or
whether a browser is involved. If you replace the signing layer with your
own, nothing else changes.

It is also what makes the verify scripts possible. They import a builder
in Node, feed it the decoded payload of a real historical transaction,
and compare the bytes against what was actually signed. See
[Verifying your port](#verifying-your-port).

---

## The minimum you need

**Two files, 314 lines**, plus WharfKit:

| file | what it is |
|---|---|
| [`src/chain/rpc.ts`](src/chain/rpc.ts) | failover across public WAX endpoints, per-request deadlines |
| [`src/chain/session.ts`](src/chain/session.ts) | the wallet. The only place anything is signed |

`rpc.ts` races a list of hosts rather than trying them in order, because
a dead WAX RPC node usually hangs instead of refusing, and a strict
try-then-timeout chain spends its whole budget on the first bad host.

`session.ts` is WharfKit and about 60 lines. It is also the only place in
the project that writes to `localStorage`. Replace it with your own
signer and no builder notices.

Most mechanics also want [`src/atomic/`](src/atomic/) (391 lines) to
answer "which NFTs does this wallet hold, and do they satisfy this
recipe". Reading is done through the public AtomicAssets indexer;
anything that decides whether a transaction is *valid* reads the chain
directly. That split is deliberate: an indexer being wrong or down should
degrade browsing, never correctness.

---

## Pick your mechanic

Each row is self-contained. Take the row, plus `chain/`, plus `atomic/`
if you need inventory matching.

### NeftyBlocks

| mechanic | contract | files | entry point |
|---|---|---|---|
| **Blend** | `blend.nefty` | `nefty/blend.ts`, `nefty/discover.ts`, `nefty/execute.ts` | `buildBlendActions(args)` |
| **Blend, random** | `blend.nefty` + ORNG | the above, plus `nefty/rngExecute.ts`, `nefty/rngWait.ts` | `buildFuseActions` then `waitForClaim` then `buildClaimAction` |
| **Claim a drop** | `neftyblocksd` | `nefty/drops.ts`, `nefty/dropExecute.ts` | `buildClaimActions(args)` |
| **Open a pack** | `atomicpacksx` | `nefty/packs.ts`, `nefty/packExecute.ts`, `nefty/packWait.ts` | `buildUnboxAnnounce` then `waitForUnboxAssets` then `buildUnboxClaim` |
| **Open a pack** | `neftyblocksp` | `nefty/neftyPacks.ts`, `nefty/neftyPackExecute.ts`, `nefty/neftyPackWait.ts` | same shape, different contract |
| **Upgrade** | `up.nefty` | `nefty/upgrades.ts`, `nefty/upgradeExecute.ts` | `buildUpgradeActions(args)` |

### The other two platforms

Both are small and depend on nothing under `nefty/`.

| platform | contract | size | note |
|---|---|---|---|
| **WaxDAO** | `waxdaomarket` | 570 lines, 2 files | settled by an NFT transfer whose memo carries a client-generated id, so `generateUniqueId` is part of the protocol, not a convenience |
| **Blenderizer** | `blenderizerx` | 506 lines, 2 files | the simplest of the three. **One** action: an `atomicassets::transfer` whose memo is the target template id. No announce, no claim, no oracle |

Two Blenderizer quirks with no equivalent elsewhere. Recipes are keyed by
their **target template**, not by a recipe id, so that is what a
shareable link carries. And the contract mints from RAM the collection
author pre-paid, so a collection with an empty `rambalance` fails every
recipe until it is topped up. Read it with `readBlenderizerRam` before
offering to sign.

Each folder has an `index.ts` that re-exports its surface grouped by
mechanic, with a header saying what a given mechanic needs at minimum.
Importing through it is optional. Reaching straight into a file works and
pulls in less.

---

## The three transaction shapes

Almost every integration bug comes from assuming there is only one.

**1. One signature.** A deterministic blend, a drop claim, an upgrade, a
WaxDAO or Blenderizer recipe. Build the array, sign it, done.

**2. Two signatures with an oracle in between.** Random blends and every
pack. You sign, the WAX ORNG oracle writes the result on chain a few
seconds later, then you sign again to collect. The wait modules
(`rngWait.ts`, `packWait.ts`, `neftyPackWait.ts`) poll for it.

The trap: between the two signatures the user's asset is **held by the
contract**, not lost. If your UI drops them there with no way back, they
will think it was stolen. Record enough to resume (the claim id, or the
pack's asset id) and offer the second signature on the next visit.

**3. Two signatures with no oracle.** Random *upgrades* look like case 2
but are not. `up.nefty` has **no `claim` action**. You sign once and the
ORNG callback rewrites the NFT's `mutable_data` a few seconds later. A
row in `up.nefty/orngjobs` tracks the pending job. There is no second
signature to build.

---

## What the ABI demands that nobody guesses

These cost real time to discover. They are the reason this project might
be worth reading even if you take no code.

**Variants are `[tag, payload]` tuples.** An ingredient is not an object
with a `kind` field. It is a two-element array whose first element is the
ABI's variant tag:

```ts
['TEMPLATE_INGREDIENT', { template_id, collection_name, amount, effect }]
```

**Field names matter, order does not.** WharfKit serialises `data`
against the live ABI by name. A misspelled key fails; a reordered object
does not.

**An attribute's declared type is not its wire type.** On `up.nefty`,
`attribute_type` is what the *schema* declares (`string`, `image`,
`uint64`, `double`, `bool`). The value travels under a different tag: an
`image` carries a `string`, a `bool` carries a `uint8`. Deriving one from
the other is the obvious mistake, so both are explicit in
[`createUpgrade.ts`](src/nefty/createUpgrade.ts).

**Vector types are not interchangeable.** For an upgrade's
`allowed_values`, the tag follows the attribute's declared type, and each
tag has its own wire shape:

| tag | shape |
|---|---|
| `STRING_VEC` | array of strings |
| `UINT64_VEC` | array of **strings**, because 64-bit values do not survive as JS numbers |
| `DOUBLE_VEC` | array of numbers |
| `UINT8_VEC` | a **hex string**, not an array. `[25]` is `"19"`, `[0]` is `"00"` |

Note also that `double` maps to `DOUBLE_VEC` in a vector but `float64` as
a scalar. The same type is spelled two ways in one ABI.

**Odds are weights, not percentages.** A blend roll's `total_odds` is the
sum of its outcome weights, and the contract does **not** normalise it. A
total that disagrees with the weights silently skews the draw instead of
erroring, so derive it rather than accept it from a form.

**An upgrade can only really change what no template freezes.** Upgrades
write an asset's `mutable_data`, but every indexer merges template
`immutable_data` **last**, so it wins in the view every marketplace
shows. Writing an attribute the template pins burns the ingredients and
changes nothing anyone can see. The chain accepts it happily.

**Token amounts carry the token's exact precision.** `10 WAX` is not
`10.00000000 WAX`. Zero-precision tokens exist, so an integer amount is
not automatically wrong either.

**Burning is the default.** An NFT ingredient with no explicit
destination is destroyed. It is one missing field between "consumed" and
"gone forever".

---

## Verifying your port

The discipline this repo is built on: **replay real transactions, compare
bytes.** Twelve scripts in [`scripts/`](scripts/) do it, and they are
also the clearest examples of using these modules outside a browser.

```bash
node scripts/verify-trace.mjs        # blends, against real signed traces
node scripts/verify-drops.mjs        # drops
node scripts/verify-packs.mjs        # pack unboxing
node scripts/verify-upgrades.mjs     # upgrades
node scripts/verify-waxdao.mjs       # waxdaomarket
node scripts/verify-blenderizer.mjs  # blenderizerx
```

The method transfers to any reimplementation, in any language:

1. Pull a real transaction of the kind you are building, from a Hyperion
   history node.
2. Fold its decoded payload back into the arguments your builder takes.
3. Run your builder.
4. Diff the result against what was signed, field by field.

One warning learned the hard way. An early harness reimplemented the
parsers instead of importing them. Its copy was correct while the shipped
code was not, so the test passed on the wrong code. Import the thing you
ship. Where you deliberately want two independent implementations to
agree, say so out loud.

---

## Credit

This code is MIT ([LICENSE](LICENSE)), which already asks you to keep the
copyright notice if you redistribute it. Beyond that, nothing here is a
condition.

If Crucible mainly helped you **understand how these contracts work**,
rather than supplying code you shipped, a line in your README is all I
would ask:

```
Contract mechanics worked out with help from Crucible
https://github.com/Zigm4/crucible
```

That case is not covered by a licence, because you are not redistributing
anything. It is just how this stays worth doing.

Crucible exists because the original websites went down while the
contracts kept running, and people found themselves locked out of assets
they owned. Every reimplementation of this knowledge makes that less
likely to happen again, whether or not it mentions me. If you fork the UI
itself, [NOTICE](NOTICE) has the one request I do make.
