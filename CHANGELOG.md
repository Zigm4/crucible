# Changelog

All notable changes to Crucible, newest first.

This project has never been tagged and `package.json` has carried
`0.1.0` since the first commit, so dates are the only anchor here. Each
entry describes what changed on that date and reflects the state of the
code at that date. Where a later entry reverses an earlier one, the
later entry says so.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/),
with one extra section: **Verified**, because byte-for-byte replay
against real on-chain transactions is the discipline this repo is
organised around. There are twelve verify scripts in `scripts/` today.

---

## 2026-08-18 - Withdraw a feature that never existed

### Fixed
- **"RNG upgrades" were listed as a few hours of UI work. There is
  nothing to wire up to.** `up.nefty` declares an `orngjobs` table, and
  that table is the whole trace of the idea: the contract has no
  `receiverand` action and no `retryrand`, so nothing can ever write a
  row into it, and it is empty. Our own `RNG` tag on an upgrade was a
  false positive: it flags any result value whose wrapper is not
  `IMMEDIATE_VALUE`, and `RESULT_VALUE` is a variant with exactly one
  member, so that branch cannot fire. Corrected in the README twice and
  in the `upgrades.ts` header. The flag itself is kept deliberately, so
  that if NeftyBlocks ever adds a second member the reader notices
  instead of silently mis-decoding it.

---

## 2026-08-11 - The guided creator picks tokens and edits what exists

### Added
- **The token list comes from the chain, with type-ahead.** A priced drop
  offered three hardcoded tickers and asked the author to type the number
  of decimals. `neftyblocksd/config.supported_tokens` carries 162 entries
  as `{token_contract, token_symbol}`, and the symbol already holds the
  precision (`4,DUST`), so neither is typed now: type two letters, pick,
  done. Typing 8 decimals for a 4-decimal token was a silent factor of
  10,000 that the contract accepts without complaint. The validator now
  rejects a token the contract does not list, which is a real rejection
  rather than a style rule.
- **`#/lab` edits as well as creates.** A Create / Change switch. In
  Change mode it lists what the collection already has, including hidden
  and ended entries, and opens the fields each contract lets an author
  change afterwards. Only what actually differs from what was loaded gets
  built, one action per change, signed together in one transaction, and
  the confirmation names each one. Deleting asks separately.
- **`up.nefty` author actions, which had no builder at all.** An upgrade
  could be created through Crucible and then never changed again, while
  blends and drops both had their equivalent. `setupgrdhide`,
  `setupgrdtime`, `setupgrdmax`, `setupgrddata`, `setupgrdcat`,
  `setupgrdsec`, `setupgrdmix` and `delupgrade` now have builders.
- `setdropdata` and `setdropprice`, the two drop admin actions that had
  no builder either.

### Verified
- All ten new author actions serialised against the live `up.nefty` and
  `neftyblocksd` ABIs before any UI was written.
- `verify-lab.mjs` grew two fixtures: a token the contract does not
  accept must be rejected, and precision must come from the token list
  rather than a form field (`3 DUST` becomes `3.0000 DUST` with symbol
  `4,DUST`). 19 payloads, 15 shape checks, 12 correct rejections.

### Removed
- **The credit card option on drops.** It was never an on-chain payment:
  NeftyBlocks took the card off chain, then had `neftybrespay` call
  `triggerclaim` to mint for the buyer. That is the same account that used
  to pay everyone's CPU and stopped signing, `triggerclaim` has no calls
  left in the history window, and the `drops` table does not even store
  the flag (it only adds the id to a `dropscc` list). Ticking it would
  have advertised a way to pay that cannot complete. The flag is now
  always false, and the price step says why.

### Known limits, stated in the editor itself
- A blend's outcomes cannot be changed by anyone: `setrolls` takes no
  `authorized_account`.
- An upgrade's attribute rewrites cannot be changed: the ABI has no
  action for them.
- Which templates a drop mints is fixed at creation.
  In all three cases the editor says so rather than leaving a reader to
  wonder why the field is missing.

---

## 2026-08-11 - The mechanics come apart cleanly

### Changed
- **The three contract families are independently liftable.** Someone who
  wants only the blend, claim or upgrade mechanics can now take a folder
  and go. `pickImageRef` moved from `ui/media.ts` to `atomic/image.ts`,
  so no module under `nefty/`, `waxdao/`, `blenderizer/`, `atomic/` or
  `chain/` imports anything from `ui/`. `BuiltAction` moved from
  `nefty/execute.ts` (which is blend-specific) to `chain/action.ts`, so
  `waxdao/` and `blenderizer/` no longer depend on `nefty/` at all. Two
  further copies of the same interface, in `dropExecute.ts` and
  `packExecute.ts`, were folded into it: one definition instead of three.
- Each family gained an `index.ts` re-exporting its surface grouped by
  mechanic, with a header saying what a given mechanic needs at minimum.
  Importing through it is optional.

### Added
- **INTEGRATING.md**: how to take these mechanics into another project.
  The minimum you need (two files, 314 lines), a table per mechanic, the
  three transaction shapes, and the ABI facts nobody guesses: variants
  are `[tag, payload]` tuples, an attribute's declared type is not its
  wire type, `UINT8_VEC` is a hex string, odds are weights the contract
  does not normalise, and an upgrade can only really change what no
  template freezes.

### Fixed
- README: the two internal links were dead. `## --- Heading ---` slugifies
  to an anchor with four hyphens a side, and both links used two. Every
  section now carries an explicit `<a id>` so the target never depends on
  how a renderer treats a decorative heading.
- README: a paragraph in the catalogue section had been garbled by an
  earlier editing pass, with a duplicated half-sentence.
- README: `claimunboxed` takes `origin_roll_ids`, not `roll_ids`.
- README: the trust table lists nine contracts, and the sentence under it
  said eight. The build has two HTML entry points, not one. The drop
  panels still use a browser `confirm()`, so "every author flow" went
  through a tick-to-confirm gate was false.
- README: `cloudflare-ipfs.com` has DNS records, it just no longer
  resolves to an address. Only two of the three named hosts are NXDOMAIN.
- Ownership-gated blends are not "far from rare", they are now the norm:
  all 40 of the 40 most recent `fuse` actions carry `OWNERSHIP_CHECK`.

### Changed, documentation
- Chain-derived counts that decay week to week are no longer pinned in
  prose. The verify scripts remain the source of exact numbers.
- 15 `[*]` code fences became real markdown lists, about 160 lines that
  could not wrap on a phone.
- Added a Contents block, dropped a `$ crucible --status` banner that
  restated the next 60 lines, and cut the UX guarantees section from nine
  bullets to the four that are not stated elsewhere. The file is 92 lines
  shorter and has 16 fewer code blocks.

---

## 2026-08-10 - One guided creator at `#/lab`

### Added
- **`#/lab`, a real guided creator over three contracts**:
  `blend.nefty::createblend`, `up.nefty::createupgrde` and
  `neftyblocksd::createdrop`, five screens each, one question per
  screen. It reads the chain, simulates against the live ABI and signs.
  Collections come from the wallet's authorizations with a manual box
  as fallback, since the contract is the real guard. Templates are
  picked from a searchable grid with artwork, name, schema and supply,
  read live from the collection. Schemas, their attribute formats and
  the collection's whitelists load in one parallel pass. Weights render
  as a stacked bar, and a plain sentence describing the recipe stays in
  view on every step.
- **The attribute gate**, which is the reason `#/lab` exists. An
  upgrade's `attribute_type` must match what the schema declares, and
  getting it wrong is the one mistake the chain does not catch. The
  type is no longer typed at all: the schema format is the authority.
  Only the seven types the encoder models are selectable, with
  unsupported ones shown disabled and explained rather than hidden (a
  uint16 would fall through `wireTypeFor()` to string and be written as
  nonsense). An attribute frozen in the immutable data of EVERY
  template it applies to is blocked, because upgrades write mutable
  data and indexers apply template immutable data last, so the
  ingredients would burn and nothing visible would change. Frozen on
  only some templates is a warning with a count, not a block.
- **`up.nefty::createupgrde` builder.** The COST side is imported from
  `createBlend.ts` rather than duplicated, giving one encoder, one
  syntax and one test suite.
- **`setblendmix` wired**, so a blend's ingredients can be changed
  after creation. The action REPLACES the whole list, so the box is
  primed from what is on chain (a blank textarea would silently drop
  everything the author does not retype), and it refuses to open at all
  for a recipe the text syntax cannot round-trip rather than offering a
  lossy box.
- **Beta confirmation gate** on author write-actions against a blend:
  an in-app dialog stating the flow is new, showing the exact summary
  of what is about to be signed, with the sign button disabled until
  the author ticks an acknowledgement. It renders on `document.body`,
  not inside `#root`, because the app re-renders by replacing `#root`'s
  innerHTML and a dialog living there could be wiped out mid-decision.

### Changed
- **Blend and upgrade creation now live only at `#/lab`.** Both
  text-syntax creation panels were removed from the BLEND and UPGRADE
  tabs along with their state, handlers, action cases and CSS, roughly
  800 lines, with `noUnusedLocals` confirming nothing was orphaned. Two
  paths meant two sets of mistakes to guard against, and only `#/lab`
  reads the collection's schema before writing to it. Kept on the main
  page deliberately: editing an existing blend including the ingredient
  editor (the only way to change a recipe, and `#/lab` does not do
  editing), whitelists and every other Manage control, and drop
  creation on the CLAIM tab which predates this work. Drops are the one
  place two creation paths remain.
- The builders were untouched by the removal: `createBlend.ts` and
  `createUpgrade.ts` are what `#/lab` calls, and their verify suites
  still replay every real creation on chain through them.
- **Outcomes are deliberately not editable, and the panel says why.**
  The proof is in the live ABI, not in a usage count: `setblendmix`
  takes `(authorized_account, blend_id, ingredients)` while `setrolls`
  takes only `(blend_id, rolls)`. With no account to authorise against,
  it is a NeftyBlocks maintenance action and an author's signature is
  rejected. History backs this up: author-signed `setblendmix` calls
  number in the hundreds, while the `setrolls` calls that can be found
  were all signed by NeftyBlocks' own accounts. A contract limit, not a
  missing button.
- Every em-dash and en-dash removed from the repository, replaced by
  " - " or restructured.

### Fixed
- Comment stripping cut into attribute VALUES, which routinely contain
  "#" ("Positive #1 level 2"). Comments are now recognised only before
  the "=".
- The `+=` validator rule rejected string attributes as a false
  negative; 14 real upgrades use `+=` on a string.

### Verified
- `verify-createupgrade.mjs`: PHASE A encoder 1558 of 1558 rebuilt to
  identical bytes across 49 collections; PHASE B 1476 round-tripped
  chain to text to chain, 82 reported not expressible rather than
  silently mangled; PHASE C live rows rebuildable across the focus
  collections; PHASE D 1558 of 1558 accepted by our own validator.
- `verify-lab.mjs`: 18 payloads built from form state and serialised
  against the live `blend.nefty`, `up.nefty` and `neftyblocksd` ABIs;
  12 recipes that MUST be rejected, each for its stated reason; and the
  attribute gate replayed against five real collections, four of them
  cross-checked against every attribute their live upgrades rewrite. It
  drives the real module rather than a copy, which is what caught the
  next item.
- The gate originally blocked any attribute frozen on some templates.
  `kingsburynft/tv` pins `img` on 70 of its 71 templates and its live
  upgrades rewrite `img` anyway, because all 124 upgraded assets belong
  to the one template that leaves it free. A blanket block would have
  refused a recipe that demonstrably works.
- All 103 underpunks55 blends round-tripped chain to text to chain
  through the new ingredient editor with zero loss and zero refusals.
- Corpus lessons on the upgrade encoder: allowed-value vectors are
  keyed by the attribute's declared type, not always STRING_VEC (167
  traces used a non-string vector); each vector type has its own wire
  shape (UINT8_VEC is a hex string, so [25] is "19"; UINT64_VEC carries
  decimal strings because 64-bit values do not survive as JS numbers;
  DOUBLE_VEC carries numbers, and the vector and scalar tags for the
  same type are spelled differently); and `attribute_type` does not
  imply the value's wire type (an `image` attribute carries a string, a
  `bool` carries a uint8).
- Phase C had to compare semantically rather than by JSON, because a
  table row spells uint64 vectors as numbers while an action spells
  them as strings; a strict diff called 4 correct rebuilds wrong.

---

## 2026-08-08 - Blend creation, verified against every creation on chain

### Added
- **`blend.nefty::createblend` builder**, the author-side counterpart
  to running a recipe.
- `total_odds` is derived from the weights rather than accepted from
  the form, because the contract does not normalise it and a
  disagreeing total silently skews the draw instead of erroring.

### Verified
- `verify-createblend.mjs`, run via `npm run verify:createblend`, which
  first compiles the real modules to ESM with `npm run build:verify`.
  - PHASE A, encoder: **10000 of 10000** real creations rebuilt to
    identical bytes, across 341 collections.
  - PHASE B, form syntax: 9991 round-tripped chain to text to chain; 9
    reported as not expressible rather than silently mangled.
  - PHASE C, live rows: **3003 of 3003** live blends across 10
    collections rebuildable exactly as they exist today, the 10 picked
    for shape (pool payouts, token payouts, attribute filters,
    cross-collection ingredients, 50-outcome tables) rather than
    convenience.
  - PHASE D, validation: **10000 of 10000** accepted by our own
    `validateNewBlend`, treating any rejection as a false negative,
    because a rule that is too strict silently blocks recipes the chain
    accepts and no byte-diff can see that.
- The harness imports the REAL parsers rather than a hand-written
  mirror. The hand-written copy had been correct while the shipped
  parser was not, so the test was passing on the wrong code. The
  ENCODER is still deliberately mirrored, so two independent
  implementations must agree.

### Fixed
Each of the following would have produced a valid-looking transaction
that built the WRONG recipe, and was caught only by scaling the corpus:
- NFT ingredients are not always burned: 18 of 362 across the 250 most
  recent creations are transferred to a vault. Hardcoding burn destroys
  NFTs an author meant to keep, and the contract accepts it without
  complaint. Disposal is now explicit per ingredient.
- Ingredients can come from another collection (streamingart mixes in
  an `alien.worlds` template), so the form takes an optional
  `collection:` prefix.
- An outcome may mint nothing (waxlandianft's 51-outcome blend opens
  with a blank at 20%).
- Outcomes are not always NFTs: the contract also pays TOKENS (801
  results) and hands out pre-minted NFTs from a POOL (1076). Roughly
  one blend in nine was being modelled as something it is not.
- Attribute ingredients can carry several filters at once (46 cases);
  ingredients carry their own `display_data` (963 cases) that the text
  form was dropping; `COOLDOWN_INGREDIENT` exists (2 cases).
- Three parser bugs: `#` comment stripping cut into pool
  `display_data` and truncated any reward whose name contains "#"; the
  `xN` multiplier was anchored to end-of-line so
  `attribute ... x2 where ...` parsed as amount 1; and `-> account`
  swallowed everything after the arrow, so 20 real creations across 6
  collections parsed the whole clause as an account name.
- Two validator false negatives: token quantities were required to have
  a decimal point, which a zero-precision token has not (castlesnftgo
  prices at "1000000 MSOURCE", 5 real creations rejected); and
  `display_data` was required to be valid JSON, which the contract
  treats as an opaque string and 202 real creations are not.
- The attribute-ingredient gap in the text form was closed, so the form
  can express every ingredient kind the contract accepts except
  `COOLDOWN_INGREDIENT`, which the encoder models but the syntax does
  not.

---

## 2026-08-07 - Pool blends, a third platform, the catalogue, and artwork

### Added
- **Pool blends.** A `POOL_NFT_RESULT` means the rewards were minted
  ahead of time and escrowed in a named pool, which is how a
  fully-minted capped template stays craftable. New `pools.ts` reads
  `blend.nefty` pools and poolassets (stock, templates, escrowed asset
  ids). The UI shows an "Expected reward" panel with pool source,
  template and live stock, and an explicit guarantee note when the pool
  holds a single template. A 1/1-odds pool blend is badged
  "guaranteed - drawn from a pool" instead of being lumped in with
  lotteries. A pool holding several templates says so, and an empty
  pool is called out before you deposit anything.
- **Blenderizer (`blenderizerx`) as a third platform.** 3DkRender's
  contract, not a Nefty one; the account predates `blend.nefty` by
  seven months and its website is gone while the contract is not. It is
  the simplest of the three blend contracts and has no blend action at
  all in its ABI: you send the NFTs and it reacts to the transfer
  notification, `atomicassets::transfer to=blenderizerx
  memo="<target_template_id>"`. One action, one signature, no announce,
  no oracle, no claim step. Recipe discovery walks the whole `blenders`
  table in parallel chunks because it has no index on collection, then
  filters client-side; target templates are resolved in one batched
  indexer call so the picker shows names. Two failure modes invisible
  in the ABI are surfaced before the user deposits anything: a capped
  target that is fully minted can never be produced again (tagged "sold
  out"), and a collection with no `rambalance` row fails every blend
  because `blenderizerx` mints from RAM the author pre-paid. Recipes
  burning more than 40 NFTs warn about CPU.
- **The collection catalogue, `#/catalog/<collection>`.** Every tab is
  one per contract, which is what you need when about to sign, but
  wrong for a player browsing. Pick a collection and seven contracts
  are scanned concurrently as six sources (both pack contracts feed one
  badge), normalised into one row shape and grouped by CATEGORY (the
  schema of the item produced) rather than by host contract, with a
  coloured source badge and one click to switch back to per-contract
  grouping. Sources are independent: one failing contract adds a
  warning line and the others still render. Unresolved entries fall
  into "uncategorised" rather than disappearing. Wallet-aware: entries
  the wallet can satisfy are marked "ready" and sorted first, the rest
  say what is missing by template. Filters are pure client-side state
  and never re-hit the chain. Read-only by design: every row deep-links
  back into the normal per-contract tab, which still does all the
  signing. Shareable.
- **NFT artwork** across blends (mint and pool reward), drops, packs,
  upgrades, WaxDAO blends, Blenderizer recipes, and as a 34px thumbnail
  in the catalogue. The hash field is not stably named: across
  underpunks55's 400 templates it is `img` 340 times but also `img2`
  (54), `img3` and `image2`, so reading only `img` would have silently
  blanked 15% of the collection. Layout is reserved before load
  (132x132, 104 on mobile, `object-fit: contain`) so nothing jumps or
  distorts; when every candidate is spent the figure is removed so the
  card collapses to its pre-artwork layout. Loading is deferred by
  IntersectionObserver with a 2.5s fallback that loads anyway, because
  in a hidden tab or a throttled embedding the callback may never
  arrive.

### Changed
- Artwork uses **six gateways led by WAX block-producer gateways**
  (`ipfs.eosdac.io`, `ipfs.alienworlds.io`), **raced rather than
  queued**: the next gateway joins in parallel after 1.2s of silence
  and the first response that decodes wins, with probes as detached
  Image objects so a slow loser cannot paint over the winner. A healthy
  gateway still costs exactly one request.
- **Privacy note.** Artwork is the app's only third-party request that
  is about the user rather than the chain. Requests carry
  `referrerpolicy="no-referrer"`, nothing is fetched until a card with
  artwork renders, and emptying `IPFS_GATEWAYS` stops every IPFS
  request in one edit.

### Fixed
- Blends paying out a `POOL_NFT_RESULT` were hard-rejected at load with
  "Unsupported blend: ... random outcome, not supported". That
  rejection was simply wrong: the action list is identical to any other
  fuse blend and every piece needed was already present. The
  `POOL_NFT_RESULT` shape was also corrected to match the live ABI
  (`{pool_name, display_data}`, not `{pool_id}`).
- A gated blend with no wallet connected no longer claims to be
  "open - no whitelist"; eligibility is unknown until a wallet
  connects.
- `pendingDeepLink` was seeded from the parsed route without checking
  the page, so landing on `#/catalog/<collection>` queued the
  collection name as a blend id and greeted the user with "Blend
  underpunks55 not found".
- **Missing artwork: six distinct causes, fixed across two commits.**
  The chain data was fine (758 templates, only 5 with no image field).
  (1) the gateway list was four generic public gateways with no
  particular reason to hold WAX media; (2) gateways were queued not
  raced, and a dead gateway hangs rather than failing, so each miss
  cost a full timeout and four gateways meant a 24s worst case; (3)
  only one reference was read, but authors fill either the result
  template's art or the recipe's own `display_data` and not both, so 11
  of underpunks55's 102 blends rendered blank for no reason; (4)
  random/multi-outcome blends had NO artwork path at all, since
  `renderRngOdds` never rendered a thumbnail, so blend 22807 was blank
  on its own page while illustrated in the catalogue; (5) every Diya
  upgrade's image is genuinely gone from all gateways, so upgrades now
  fall back to the artwork of an NFT they accept; (6) `up.clothes` was
  fine in every respect but its loads were being destroyed, because
  every `render()` replaces `#root`'s innerHTML and a page that
  re-renders while data streams in can restart a thumbnail
  indefinitely. Winning URLs and proven-hopeless candidate lists are
  now memoised.
- Honesty caveat kept from the investigation: precise artwork coverage
  could not be measured from the dev environment because background
  timers were throttled and hosts filtered, so every rate produced
  there was noise. What is confirmed is that artwork loads and that
  `ipfs.eosdac.io` wins in practice.

### Verified
- `verify-pool-blend.mjs`: the whole pool path against live chain
  state, with the action list serialised against the live ABIs.
  Confirmed on blend 42787 (underpunks55, "Volna-57 Geiger Counter"): 9
  escrowed assets of template 893664 read, and announcedepo, transfer
  and fuse serialising to 12, 65 and 67 bytes.
- `verify-blenderizer.mjs`: against trace `35551867...d2aa`
  (cryptoviking, recipe 106051, 11 NFTs): contract identity, recipe
  shape, the deposited assets' templates, and our action reproducing
  the original transfer byte for byte.

---

## 2026-06-27 to 2026-06-28 - The correctness pass

### Fixed
- **Fuse routing is chosen by SECURITY, not by randomness.**
  `nosecfuse` is for non-secure blends whether deterministic or random;
  `fuse`, carrying the security check, is for secure or whitelisted
  ones. This fixed two real classes of failure: non-secure RANDOM
  blends were sent `fuse` and rejected with "Non secure blends require
  a transfer or nosecfuse" (blend 6333 among them), and secure
  DETERMINISTIC whitelist blends were sent `nosecfuse` and rejected by
  checksecure. Verified byte for byte against successful on-chain
  transactions for all four cases.
- **Random blend results are minted automatically** by Nefty's
  on-chain claim service (`setup.nefty`); the user only signs TX1. The
  flow no longer waits for a manual claim that never comes and then
  reports a scary false failure. It now reports success, detects when
  the staged row is consumed, and keeps manual claim only as a
  fallback. A manual claim that loses the race to the auto-claimer
  reads as success.
- **NFT-cost upgrades are completable.** The builder already emitted
  the right actions but the UI hard-coded `transferred_assets: []`, so
  upgrade 174 and its kind could never be signed. There is now a picker
  per TEMPLATE / SCHEMA / COLLECTION cost ingredient, honouring the
  required amount and preventing reuse of an asset across slots.
  Verified byte for byte against a real on-chain NFT-cost upgrade.
- Drop management stayed stuck to the CLAIM tab. The URL is now pinned
  to `#/nefty/claim/<id>` so a WAX Cloud Wallet page reload returns to
  CLAIM instead of bouncing to BLEND, and `runDropAdminAction` restores
  platform, view and hash in its `finally` block and discards any deep
  link queued mid-signing, because a wallet round-trip can flip the
  active view.
- After a successful drop-admin write the panel waits briefly before
  re-reading, so the RPC node has indexed the new block.

### Added
- **NeftyBlocks-native pack opening (`neftyblocksp`)** alongside
  AtomicHub's `atomicpacksx`. The Unpack tab merges both sources and
  routes each pack's open and claim by its contract (transfer memo
  "unbox", then `neftyblocksp::claim` with `claim_id == pack asset_id`).
- **A standalone, theme-aware user guide (`guide.html`)**, its own Vite
  entry, replacing the raw README link, with a three-skin theme switch
  (Neon / Clair / Sombre).
- **`#/status`, a client-side read-only contract monitor.** For each
  watched account it reads `last_code_update` (exact date plus relative
  age), the code hash (present vs wiped) and the latest action via
  Hyperion to spot a silent contract. Health is scored against a
  baseline captured on chain at implementation time: healthy, code
  changed vs baseline, no code, silent, unreachable, plus service and
  legacy-inactive cases. Grouped by platform, each card with a
  plain-language role and an explorer link. Bookmarkable, no wallet
  needed.

### Changed
- **Transaction feedback consolidated into one full-width banner**
  pinned to the top of the viewport and painted over everything, green
  for success and red for failure, replacing the easy-to-miss
  bottom-right toast and the per-panel inline banners. It carries a
  "copy tx link" button, with the full transaction id threaded from
  every confirmation site (drop admin, drop claim, blend, upgrade,
  create drop, WaxDAO), and an explicit close. The idle "Ready. Pick a
  collection..." status line is gone. The drop Manage panel keeps only
  an in-progress line; its outcome shows in the global banner.
- Responsive tab bar: the four Nefty tabs shrink to fit a phone, with
  the contract sub-label hidden below 560px.
- Remaining French user-facing strings translated to English
  (`whitelist.ts`, `blend.ts`, `main.ts`).
- README limitations rewritten and grouped by cause; the resolved
  NFT-cost-upgrade limitation dropped; the RNG-upgrade flow corrected
  (`up.nefty` has no claim action anywhere); a Themes section added.
- GitHub Pages workflow actions bumped off deprecated Node 20 (checkout
  v4 to v7, setup-node v4 to v6, configure-pages v5 to v6,
  upload-pages-artifact v3 to v5, deploy-pages v4 to v5) and the build
  moved to Node 22.

---

## 2026-06-02 - Recipes say what they mean

### Changed
- Template names instead of bare ids across blend ingredient slot
  headers, random-blend outcome odds, the blend picker rows and toggle,
  and the UPGRADE tab's cost ingredients, spec requirements and
  asset-slot labels. The id stays as a fallback where a template
  genuinely has no name.

---

## 2026-05-28 to 2026-05-29 - Collection authors get real tools

### Added
- **Blend management**, inline in the BLEND tab, shown only when the
  connected wallet is an authorized account of the collection and
  behind an opt-in "enable management controls" toggle that is off by
  default. `setblendhide`, `setblendtime`, `delblend`, `setblendmax`,
  `setblendlim`, `setblenddata`, `setblendsec`, plus `secure.nefty`
  `addtowl` / `erasefromwl` / `clearwl` / `addwhitelist`. In practice:
  hide and unhide, end now, rename, max uses, per-account limit and
  cooldown, attach or create a whitelist, edit its members, delete with
  confirmation. Every action runs confirm, sign, then reload the blend
  so the UI shows the new on-chain state.
- **A usable whitelist editor.** Before it, an author could not add a
  single wallet. There is now a picker over all the collection's lists
  marking the one attached to the blend, removable wallet chips, a bulk
  add textarea, auto-selection of a newly created list, and copy
  clarifying that the name field is a label and not a wallet.
- **Drop authoring on the CLAIM tab**, opt-in and gated on an
  authorized account. Create a drop end to end via
  `neftyblocksd::createdrop`: display data, templates with
  per-template quantities, price or free, max supply or unlimited,
  per-account limit and cooldown, start and end, whitelist requirement,
  hidden, price recipient, credit-card payments. Touchy options
  (minted templates, unlimited or free supply, payout account, empty
  gated drop) are boxed in red with the reason. On success the new
  `drop_id` is parsed out of the transaction and the drop auto-loads
  into Manage.
- **Manage a drop**: load any drop by id including hidden and gated
  ones, or pick from "drops I can manage"; edit the per-drop whitelist,
  toggle the whitelist requirement, hide and unhide, delete.

### Fixed
- The blend scan could hang forever. `atomicFetch()` had no request
  timeout, so when an indexer host accepted the connection and never
  answered, the failover loop blocked on the dead host and the working
  on-chain fallback never ran. Each request is now aborted after a
  deadline and each RPC call is raced against one, so a timed-out host
  fails over. The indexer fallback timeout was then raised to 10s.

### Verified
- `verify-admin.mjs`: 10 of 10 admin actions byte-for-byte against
  historical traces signed by real collection managers (setblendhide,
  setblendtime, delblend, setblendmax, setblendlim, setblenddata,
  setblendsec, and `secure.nefty` addtowl / erasefromwl / addwhitelist).

---

## 2026-05-20 - Upgrades, a second platform, and links you can share

### Added
- **UPGRADE tab against `up.nefty`**: discovery, recipe view (cost plus
  mutations), per-spec NFT picker, sign and broadcast.
- **WaxDAO (`waxdaomarket`) as a second platform**: per-collection
  recipe discovery, ingredient and result decoding, and an
  `assertblend` plus one `atomicassets::transfer` per NFT slot using
  the slot-indexed memo `|blend_deposit|<id>|<slot>|`, with a
  client-side `unique_id` for the contract's pending-order dedup.
- **Platform pill bar** above the tabs; the tab bar shows only the
  active platform's tabs, since the platforms have independent ID
  spaces.
- **Deep-linkable, shareable URLs**: `#/nefty/blend/43444`,
  `#/nefty/claim/237418`, `#/nefty/upgrade/447`, `#/waxdao/blend/1921`.
  Landing on one auto-loads the recipe and banners it inside the
  Connect-wallet card. Every info card gets a "share link" button.
  Reading a recipe needs no wallet; only signing does.
- **Asset name resolution** in the NFT picker: `a.name`, then
  `a.data.name`, then cached template name, then `template #<id>`, with
  a cross-tab cache so the second paint is instant.

### Fixed
- Picker dropdowns were captured by a card's `backdrop-filter` stacking
  context, so `position: fixed` behaved like absolute and panels bled
  under sibling cards. Open panels are now portaled to `<body>` after
  position is computed.
- Blends and drops sorted by status priority then alphabetically; the
  badge legend extended to every badge the picker can emit.

### Verified
- `verify-upgrades.mjs`: byte-for-byte against two real on-chain traces
  (an FT-only and an FT+NFT upgrade).
- `verify-waxdao.mjs`: byte-for-byte against a real WaxDAO blend
  (`71d4917b`, Back Scratcher blend 1127), 5 of 5 actions matching.

---

## 2026-05-19 - Unpack, random blends, and drops you can judge before signing

### Added
- **UNPACK tab against `atomicpacksx`**: a two-signature flow with an
  automatic ORNG wait between TX1 and TX2.
- **Cross-collection pack discovery**: a global scan of
  `atomicpacksx::packs` paired against the wallet's inventory, then
  cascading dropdowns (collection to pack type to mint) listing only
  collections where the user owns an openable pack.
- **Random blends**: the announce and fuse leg followed by a claim leg,
  with a state machine in BLEND mirroring UNPACK, and the full outcome
  list with per-roll odds shown BEFORE the second transaction. (The
  second signature turned out to be unnecessary; see 2026-06-27.)
- **Unbox outcome breakdown**: each resolved card with template name,
  template id and the in-roll probability of that exact outcome.
- **Multi-collection support**: free-form collection input plus
  suggestion chips, no hardcoded default, and on-demand discovery so
  nothing loads on mount.
- **Drop variants** `claimdrop`, `claimdropwl` and `claimwproof`, with
  automatic NFT-proof matching from the wallet.
- **Drop name resolution**: when a drop's on-chain `display_data` has
  no name, fall back to the primary mint template's name from the
  AtomicAssets indexer.
- **Token affordability for paid drops**: per-ticker balance read after
  Discover, an "insufficient TICKER" badge in the picker, and a notice
  giving current balance, required amount and the exact top-up delta.
  Sign is blocked so CPU is not wasted on a transaction that would
  revert.
- **Per-account claim limit detection** with cooldown awareness, and
  "only show what I can blend / claim" filters.
- MIT license plus a NOTICE asking forks to keep the "Powered by
  Crucible" attribution.

### Changed
- Fixable blockers (missing NFT proof, insufficient token) stay
  selectable so the user can open the card and read what is required;
  hard blockers (whitelist denied, key-gated, structurally
  unclaimable, limit hit) stay disabled.
- Blocker reasons moved next to the Sign button in plain English,
  listing each proof filter and its AND/OR operator.
- Picker layout rework, and a rAF-batched render loop to kill flicker.
- `style.css` split into `theme.css`, `layout.css` and
  `components.css`, so a fork re-skins by overriding one file without
  touching geometry or component behaviour.
- Explorer links moved to waxblock.io from wax.bloks.io.

### Verified
- `verify-packs.mjs`: the unbox action list is byte-for-byte identical
  to a real historical unbox trace.

---

## 2026-05-16 - Crucible ships

### Added
- A single static page that talks directly to `blend.nefty` and
  `neftyblocksd` and asks the wallet to sign. No backend, no added fee,
  no telemetry.
- Built by decoding live transaction traces and reproducing their
  action structure byte for byte.

### Verified
- Three Node scripts at birth: `verify-trace.mjs`, `verify-drops.mjs`
  and `verify-discover-chain.mjs`. They prove the actions Crucible
  builds are byte-identical to historical reference transactions that
  actually succeeded on chain. That is the discipline the whole repo is
  organised around.
