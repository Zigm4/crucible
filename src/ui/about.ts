/**
 * The inline guide that lives at the top of the app. Same idea as the
 * Discord article, lightly tweaked for in-app reading (no "open the
 * tool" step since the reader is already inside it).
 *
 * Each panel is rendered as a native <details>/<summary>, so the
 * cyberpunk theme can style them with CSS only.
 */

interface Panel {
  id: string;
  /** Header text shown collapsed; click expands the body. */
  summary: string;
  /** HTML body. Keep it audited; nothing is escaped on render. */
  body: string;
  /** When true, the panel opens by default on first render. */
  open?: boolean;
}

const PANELS: Panel[] = [
  {
    id: 'about',
    summary: 'WHAT IS CRUCIBLE?',
    body: `
      <p>
        Nefty.io shut down its website, and the WaxDAO site is down too.
        A lot of people assumed blending, claiming and crafting were
        over. <strong>They aren't.</strong>
      </p>
      <p>
        On a blockchain, the <em>website</em> and the <em>smart
        contract</em> are two completely different things. The
        websites are gone, but the contracts behind them
        (<code>blend.nefty</code>, <code>neftyblocksd</code>,
        <code>atomicpacksx</code>, <code>up.nefty</code>,
        <code>waxdaomarket</code>) are still running on WAX mainnet,
        24/7, exactly as they were. They can't be "shut down" by
        anyone, including the companies that deployed them.
      </p>
      <p>
        <strong>Crucible</strong> is a small open-source page that
        talks directly to those contracts. It is the missing UI for
        all of them.
      </p>
      <ul>
        <li><strong>I take zero cut.</strong> No fee to me, no
        commission. The blend / drop / upgrade fees that always
        existed still go where they always went.</li>
        <li><strong>No backend.</strong> One HTML file plus JavaScript.
        No server I run, no database, nothing tracking you.</li>
        <li><strong>No persistent storage.</strong> Every page load
        is a clean boot. The only thing the page reads is the URL
        hash (for shareable links to a specific blend / drop /
        upgrade).</li>
        <li><strong>Open source.</strong> Read every line. Fork it,
        host it yourself, never trust me again. That's the whole
        point.</li>
        <li><strong>Your keys never leave your wallet.</strong>
        Anchor and WAX Cloud Wallet sign locally. I never see
        anything.</li>
      </ul>
    `,
  },
  {
    id: 'how-blends-work',
    summary: 'WHAT A BLEND ACTUALLY IS · 90 SECOND CRASH COURSE',
    body: `
      <p>
        Every action on WAX is a tiny message you send to a "smart
        contract", which is a public program living on the chain.
        Smart contracts have rules they enforce automatically. They
        can't lie, they can't change behind your back, and they can't
        disappear.
      </p>
      <p>
        A <strong>blend</strong> is just a sequence of those
        messages. When you blended an NFT through Nefty in the past,
        your wallet was sending roughly this script:
      </p>
<pre><code>1. announcedepo      "I'm about to deposit N NFTs"
2. transfer (NFTs)   "Here are the NFTs, memo: deposit"
3. nosecfuse         "Now burn them and mint my result"</code></pre>
      <p>
        For blends that also cost tokens (like UPMAX-paid blends),
        two more steps are added at the start:
      </p>
<pre><code>0a. openbal             "Reserve a balance slot for UPMAX" (once, ever)
0b. transfer (UPMAX)    "Here's the token cost, memo: deposit"</code></pre>
      <p>
        For <strong>random</strong> blends (any roll with more than
        one possible outcome) the final action becomes
        <code>fuse</code> and you sign a second transaction
        (<code>claim</code>) a few seconds later, once the on-chain
        oracle has staged your result. Crucible auto-waits between
        the two signatures and shows you the resolved outcome with
        its probability before you sign step 2.
      </p>
      <p>
        The contract receives those messages, verifies the
        ingredients match the recipe, burns them, mints the output,
        and ships the result to your wallet. <strong>Every blend you
        ever did followed this exact flow.</strong> Nefty's website
        was just a friendly wrapper.
      </p>
      <p>
        <strong>One change:</strong> Nefty used to pay your CPU via
        an account called <code>neftybrespay</code>. That account no
        longer signs, so you'll need a little WAX staked to CPU
        yourself. Typically <strong>5 to 10 WAX is plenty</strong>.
        You stake it once from your wallet's "Resources" tab; you
        can unstake later.
      </p>
    `,
  },
  {
    id: 'platforms',
    summary: 'TWO PLATFORMS · FIVE CONTRACTS · ONE PAGE',
    body: `
      <p>
        Crucible covers two parallel ecosystems on WAX. Pick the
        platform with the top pills:
      </p>
      <ul>
        <li>
          <strong>NeftyBlocks</strong> · four contracts, four tabs:
          <ul>
            <li><strong>Blend</strong> (<code>blend.nefty</code>):
            burn NFTs (and optionally pay tokens) to mint a result.
            Handles deterministic blends in one signature and random
            blends in two.</li>
            <li><strong>Claim</strong> (<code>neftyblocksd</code>):
            pay (or not) to mint a drop. Public, whitelist, and NFT-
            proof drops are all signable.</li>
            <li><strong>Unpack</strong> (<code>atomicpacksx</code>):
            open packs you already hold. Cross-collection
            discovery, two signatures with auto-wait for the ORNG
            oracle between them.</li>
            <li><strong>Upgrade</strong> (<code>up.nefty</code>):
            mutate NFTs you own. The asset stays in your wallet,
            only its on-chain mutable_data changes (image, colour,
            level, etc.).</li>
          </ul>
        </li>
        <li>
          <strong>WaxDAO</strong> · one contract, one tab (for now):
          <ul>
            <li><strong>Blend</strong> (<code>waxdaomarket</code>):
            same idea as Nefty's blend, different action shape. One
            <code>assertblend</code> + one transfer per ingredient
            slot, slot index in the memo. Crucible drives the
            contract directly even though waxdao.io itself is
            down.</li>
          </ul>
        </li>
      </ul>
      <p>
        The two platforms have <em>separate ID spaces</em>: blend
        <code>#1127</code> on <code>blend.nefty</code> is a totally
        different recipe from blend <code>#1127</code> on
        <code>waxdaomarket</code>. The platform pill above the tab
        bar tells you which one is active.
      </p>
    `,
  },
  {
    id: 'how-to-use',
    summary: 'HOW TO USE THIS PAGE · STEP BY STEP',
    body: `
      <ol>
        <li>
          <strong>Connect your wallet</strong> at the top of the page
          (Anchor or WAX Cloud Wallet). If you blended or claimed
          before, you already have one.
        </li>
        <li>
          <strong>Stake ~5 to 10 WAX in CPU</strong> in your wallet's
          "Resources" tab. You aren't spending it; you can unstake
          later. Without enough CPU, transactions fail with
          <code>exceeded the account CPU limit</code>.
        </li>
        <li>
          <strong>Pick a platform</strong> with the top pills
          (NeftyBlocks or WaxDAO), then a tab inside that platform.
        </li>
        <li>
          <strong>Pick the entity</strong> from the dropdown. The list
          auto-fills with everything matching the selected collection
          when you click <em>Discover</em>. You can also paste a
          numeric ID manually if you have it.
        </li>
        <li>
          <strong>Inspect what the contract wants.</strong> The page
          reads the recipe directly from the chain: which NFTs to
          burn, token cost, expected mint, whitelist status, and any
          mutations (for upgrades).
        </li>
        <li>
          <strong>Pick inputs</strong> in the slot card. The grid is
          filtered to NFTs you actually own that match each slot.
          Token costs are pre-flighted against your balance.
        </li>
        <li>
          <strong>Click "Simulate" first.</strong> The transaction is
          built locally and printed. Nothing is sent yet. If
          something looks wrong, stop.
        </li>
        <li>
          <strong>Click "Sign &amp; broadcast".</strong> Your wallet
          shows the actions, you confirm. A few seconds later, a
          <code>waxblock.io</code> link to the transaction appears.
        </li>
        <li>
          For <strong>random blends</strong>, <strong>packs</strong>,
          and <strong>random upgrades</strong>, a second signature is
          needed after the on-chain oracle has rolled the result.
          Crucible polls the chain automatically and prompts you for
          step 2 when ready.
        </li>
      </ol>
      <p class="term">
        If something doesn't work, share the entity ID, the on-page
        error text, and whether you staked CPU. The whole tool exists
        exactly so that nobody (including me) can ever be a single
        point of failure for our communities again.
      </p>
    `,
  },
  {
    id: 'sharing',
    summary: 'SHAREABLE LINKS · SEND ANYONE TO A SPECIFIC RECIPE',
    body: `
      <p>
        Every blend, drop, and upgrade has its own shareable URL.
        Once you've picked one, the page address updates automatically
        to a hash like:
      </p>
<pre><code>#/nefty/blend/43444     -- a NeftyBlocks blend
#/nefty/claim/237418    -- a NeftyBlocks drop
#/nefty/upgrade/447     -- a NeftyBlocks upgrade
#/waxdao/blend/1921     -- a WaxDAO blend (e.g. STARBORE)</code></pre>
      <p>
        Anyone opening one of those URLs lands directly on the right
        platform + tab and Crucible auto-loads the recipe for them.
        If they don't have a wallet connected yet, a banner inside
        the "Connect wallet" card tells them what they're looking at
        and invites them to sign in.
      </p>
      <p>
        Once you've picked an entity, the info card (zone 3) shows
        a <strong><code>⎘ share link</code></strong> button next to
        the title. Click it: the current URL goes to your clipboard,
        ready to paste in Discord, Twitter, Telegram, wherever.
      </p>
      <p>
        Reverse direction works too: typing or pasting one of those
        hashes into your address bar is enough. No login required to
        read the recipe; the wallet is only needed to sign.
      </p>
    `,
  },
  {
    id: 'claims',
    summary: 'CLAIMS · A SECOND SMART CONTRACT, SAME IDEA',
    body: `
      <p>
        Blends aren't the only thing Nefty's UI was wrapping.
        <strong>Drops</strong> are the "claim an NFT, pay 50 WAX, mint
        delivered to your wallet" feature. They live in a separate
        contract called <code>neftyblocksd</code>. Same story: the
        contract is still alive on-chain, only the website is gone.
      </p>
      <p>
        Switch to the <strong>CLAIM</strong> tab to browse drops for
        the selected collection. Each drop has its own auth flavour,
        all of which Crucible can handle except one:
      </p>
      <ul>
        <li><strong>Public.</strong> Anyone can claim. One signed
        action: <code>claimdrop</code>.</li>
        <li><strong>Whitelist</strong> (per-account). The drop
        creator listed accounts that are allowed. Crucible checks
        your account against the on-chain whitelist and uses
        <code>claimdropwl</code>.</li>
        <li><strong>NFT proof.</strong> You must own specific NFTs
        to be allowed. Crucible reads the proof rule from on-chain,
        scans your wallet for matching NFTs, and passes their
        asset_ids to <code>claimwproof</code>. If you don't satisfy
        the rule, the row stays clickable so you can see the
        requirement in plain English and know what to buy.</li>
        <li><strong>Authkey</strong> (signed message). The drop
        creator gives each user a signed key off-chain. Without
        that key the contract refuses; Crucible can't help here.</li>
      </ul>
      <p>
        When a drop is <em>paid</em>, Crucible pre-flights your
        balance for the settlement token and shows the exact top-up
        needed if you're short. The Sign &amp; claim button stays
        disabled until you have enough, so you can never waste CPU
        on a tx that's going to revert.
      </p>
<pre><code>1. neftyblocksd::assertprice      "lock this price"
2. &lt;token&gt;::transfer             "here's the payment, memo: deposit"
3. neftyblocksd::claimdrop / wl / wproof</code></pre>
      <p>
        Free drops skip steps 1 and 2 entirely. Only the claim
        action is signed.
      </p>
    `,
  },
  {
    id: 'unpack',
    summary: 'UNPACK · OPEN PACKS WITH THE ORNG ORACLE',
    body: `
      <p>
        Pack opening lives on a third contract,
        <code>atomicpacksx</code>. It's a commit-reveal flow with the
        on-chain ORNG randomness oracle, so opening a pack takes
        <strong>two wallet signatures</strong>:
      </p>
<pre><code>TX 1  atomicassets::transfer  to=atomicpacksx, memo="unbox"
      "Take this pack, ask the oracle for randomness."

      ... 5..30 seconds while ORNG calls the contract back ...

TX 2  atomicpacksx::claimunboxed  pack_asset_id, origin_roll_ids
      "Randomness is in, mint my cards."</code></pre>
      <p>
        The <strong>UNPACK</strong> tab scans
        <code>atomicpacksx</code> globally and lists only the
        collections where your wallet currently holds at least one
        openable pack. You then pick: collection, pack type, specific
        mint (when you own more than one of the same).
      </p>
      <p>
        Between TX1 and TX2, Crucible polls the
        <code>unboxassets</code> table every 2 seconds. When the
        oracle row appears, you see exactly which templates the
        contract picked, with the in-roll probability of each
        outcome, BEFORE you sign step 2.
      </p>
    `,
  },
  {
    id: 'upgrade',
    summary: 'UPGRADE · MUTATE NFTS YOU OWN IN PLACE',
    body: `
      <p>
        The <strong>UPGRADE</strong> tab drives a fourth Nefty
        contract, <code>up.nefty</code>. Upgrades are different from
        blends in a key way: they <strong>mutate</strong> NFTs you
        already hold instead of burning them. The asset stays in your
        wallet; only its on-chain <code>mutable_data</code> is
        rewritten (image, colour, level, etc.).
      </p>
      <p>
        On-chain shape, mirroring blend.nefty but with an extra
        <code>assets_to_upgrade</code> field that lists the NFTs
        being mutated:
      </p>
<pre><code>[0a. up.nefty::openbal               once per (owner, FT) ever]
[0b. &lt;token&gt;::transfer  memo=deposit  one per FT ingredient]
 1.  up.nefty::announcedepo          (only when burning NFTs as cost)
 2.  atomicassets::transfer  memo=deposit
 3.  up.nefty::upgrade               assets_to_upgrade=[ ... ]</code></pre>
      <p>
        FT-only upgrades (the most common case, e.g. underpunks55's
        Maschine Key Card colour upgrades) are fully signable from
        Crucible today. Random-result and whitelist-gated upgrades
        are detected, tagged in the picker, and on the roadmap.
      </p>
    `,
  },
  {
    id: 'waxdao',
    summary: 'WAXDAO · CRAFTS THE NEFTY UI NEVER WRAPPED',
    body: `
      <p>
        <strong>WaxDAO</strong> is a parallel ecosystem to
        NeftyBlocks. Its blends live in a different contract
        (<code>waxdaomarket</code>) and use a different action shape:
        instead of one big transfer with all the NFTs in it, every
        ingredient gets its own <code>atomicassets::transfer</code>
        with a slot-indexed memo:
      </p>
<pre><code>1.  waxdaomarket::assertblend           { blend_ID, user, unique_id }
[2. &lt;token&gt;::transfer  to=waxdaomarket
                          memo="|blend_deposit|&lt;id&gt;|0|"]
 3. atomicassets::transfer  to=waxdaomarket
                            memo="|blend_deposit|&lt;id&gt;|1|"
 4. atomicassets::transfer  to=waxdaomarket
                            memo="|blend_deposit|&lt;id&gt;|2|"
 ... one transfer per NFT ingredient slot</code></pre>
      <p>
        The WaxDAO website is currently down, but the
        <code>waxdaomarket</code> contract is alive and independent.
        Crucible drives it directly, exactly as it does for the
        Nefty contracts.
      </p>
      <p>
        Click the <strong>WAXDAO</strong> pill at the top of the
        page to switch context. Recipes are listed per collection,
        sorted alphabetically. The byte-for-byte verifier
        (<code>scripts/verify-waxdao.mjs</code>) confirms that the
        actions Crucible builds are identical to a real on-chain
        WaxDAO blend executed in 2024.
      </p>
    `,
  },
  {
    id: 'author-manage-blends',
    summary: 'AUTHOR TOOLS · MANAGE YOUR BLENDS & WHITELISTS',
    body: `
      <p>
        If the connected wallet is an <strong>authorized account</strong>
        of a collection (its author, or in the collection's
        <code>authorized_accounts</code>), Crucible reveals inline
        <strong>Manage</strong> controls — the contracts always allowed
        this; only the website was missing.
      </p>
      <p>
        On the <strong>BLEND</strong> tab, once you load a blend you own,
        a "⚙ MANAGE" panel appears (behind a safety toggle). It can rename,
        hide/unhide, set the time window, change max uses / per-account
        limits, delete the blend, and manage <strong>whitelists</strong>:
      </p>
      <ul>
        <li>blend whitelists are reusable named lists
        (<code>secure.nefty</code> <code>security_id</code>) — you can
        create one, fill it with wallets, and attach it to one or several
        blends. Editing the list affects every blend it gates.</li>
      </ul>
      <p>
        Every admin action carries an <code>authorized_account</code> the
        contract re-checks, so the panel is just a convenience: the chain
        is the real guard.
      </p>
    `,
  },
  {
    id: 'author-drops',
    summary: 'AUTHOR TOOLS · CREATE & MANAGE DROPS',
    body: `
      <p>
        On the <strong>CLAIM</strong> tab, two opt-in panels let an
        authorized account run a NeftyBlocks drop end to end:
      </p>
      <ul>
        <li><strong>Create a drop</strong> (<code>neftyblocksd::createdrop</code>):
        mint a drop from <em>existing templates</em>, with the standard
        options — name/description/image, templates &amp; quantities,
        price (or free), supply (or unlimited), per-account limit +
        cooldown, start/end window, whitelist requirement, hidden, price
        recipient, credit-card payments. Touchy options (the minted
        templates, unlimited/free supply, the payout account) are boxed in
        <strong>red</strong> with an explanation; routine controls stay in
        the amber style.</li>
        <li><strong>Manage a drop</strong>: load any drop you manage — by
        picking it from "drops I can manage", or by id (works for hidden /
        gated drops the claim list hides). Edit its whitelist (add / remove
        / clear), toggle the whitelist requirement, hide/unhide, or delete.</li>
      </ul>
      <p>
        Unlike blend whitelists, a <strong>drop's whitelist is per-drop</strong>:
        <code>neftyblocksd</code> has no reusable named lists, so you add
        wallets directly to that drop (table <code>whitelists</code>, scoped
        by <code>drop_id</code>). A drop created with "whitelist required"
        starts <strong>empty</strong> — nobody can claim until you add
        accounts in Manage a drop.
      </p>
    `,
  },
];

/**
 * Renders all panels as a `<section class="about">` so the cyberpunk
 * theme can target them with a single selector. The wrapper appears
 * first on the page; the rest of the app renders below.
 */
export function renderAboutPanels(): string {
  // Collapsed by default: the whole guide lives behind one line so it
  // doesn't dominate the page. Click to expand the FAQ, then each topic
  // expands on its own.
  return `
    <section class="about">
      <details class="about-toc">
        <summary><span>ℹ INFO &amp; FAQ — what Crucible is, how to use it, author tools</span></summary>
        <div class="about-toc-body">
          ${PANELS.map(
            (p) => `
            <details class="about-panel"${p.open ? ' open' : ''}>
              <summary><span>${p.summary}</span></summary>
              <div class="about-body">${p.body}</div>
            </details>`,
          ).join('')}
        </div>
      </details>
    </section>`;
}
