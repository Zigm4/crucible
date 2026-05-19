/**
 * The inline guide that lives at the top of the app. Same content the
 * Underpunks Discord article uses, lightly tweaked for in-app reading
 * (no "open the tool" step since the reader is already inside it).
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
    open: true,
    body: `
      <p>
        Nefty.io shut down its website, so a lot of people assumed
        blending was over. <strong>It isn't.</strong>
      </p>
      <p>
        On a blockchain, the <em>website</em> and the <em>smart
        contract</em> are two completely different things. Nefty's
        website is gone, but the contract that runs the blends
        (<code>blend.nefty</code> on WAX mainnet) is still running,
        24/7, exactly as it was. It can't be "shut down" by anyone,
        including Nefty.
      </p>
      <p>
        <strong>Crucible</strong> is a small open-source page that
        talks directly to that contract. It is the missing UI.
      </p>
      <ul>
        <li><strong>I take zero cut.</strong> No fee to me, no
        commission. The blend fees that always existed (paid to
        <code>fees.nefty</code> and to the collection author) still go
        where they always went.</li>
        <li><strong>No backend.</strong> One HTML file plus JavaScript.
        No server I run, no database, nothing tracking you.</li>
        <li><strong>Open source.</strong> Read every line. Fork it,
        host it yourself, never trust me again. That's the whole
        point.</li>
        <li><strong>Your keys never leave your wallet.</strong> Anchor
        and WAX Cloud Wallet sign locally. I never see anything.</li>
      </ul>
    `,
  },
  {
    id: 'how-blends-work',
    summary: 'WHAT A BLEND ACTUALLY IS · 90 SECOND CRASH COURSE',
    body: `
      <p>
        Every action on WAX is a tiny message you send to a
        "smart contract", which is a public program living on the
        chain. Smart contracts have rules they enforce
        automatically. They can't lie, they can't change behind
        your back, and they can't disappear.
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
        The contract receives those messages, verifies the
        ingredients match the recipe, burns them, mints the output,
        and ships the result to your wallet. <strong>Every blend you
        ever did followed this exact flow.</strong> Nefty's website
        was just a friendly wrapper that built those messages for
        you.
      </p>
      <p>
        Crucible does the same job, in under a megabyte of
        JavaScript. It reads the live recipe straight from the
        chain, lets you pick your inputs, builds the same messages,
        and asks your wallet to sign. The chain doesn't care which
        UI sent them. Same fees go to the same places. Same result
        NFT lands in your wallet.
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
    id: 'how-to-use',
    summary: 'HOW TO USE THIS PAGE · STEP BY STEP',
    body: `
      <ol>
        <li>
          <strong>Connect your wallet</strong> at the top of the page
          (Anchor or WAX Cloud Wallet). If you blended before, you
          already have one.
        </li>
        <li>
          <strong>Make sure you've staked ~5 to 10 WAX in CPU</strong>
          in your wallet's "Resources" tab. You aren't spending it;
          you can unstake later.
        </li>
        <li>
          <strong>Pick a blend</strong> from the dropdown. The list
          auto-fills with active blends for the selected collection.
          You can also paste a <code>blend_id</code> manually if you
          have it.
        </li>
        <li>
          <strong>Inspect what the blend wants.</strong> The page
          reads the recipe directly from the contract: which NFTs to
          burn, token cost, expected mint, whitelist status.
        </li>
        <li>
          <strong>Click "Simulate" first.</strong> The transaction is
          built locally and printed. Nothing is sent yet. If
          something looks wrong, stop.
        </li>
        <li>
          <strong>Click "Sign &amp; broadcast".</strong> Your wallet
          shows the 3 to 5 actions, you confirm. A few seconds later,
          a <code>waxblock.io</code> link to the transaction appears.
        </li>
      </ol>
      <p>
        Done. The new NFT is in your wallet. The flow is identical
        to what Nefty's UI used to do, minus the dead website.
      </p>
      <p class="term">
        If something doesn't work, share the <code>blend_id</code>,
        the on-page error text, and whether you staked CPU. The
        whole tool exists exactly so that nobody (including me) can
        ever be a single point of failure for our community again.
      </p>
    `,
  },
  {
    id: 'claims',
    summary: 'CLAIMS · A SECOND SMART CONTRACT, SAME IDEA',
    body: `
      <p>
        Blends aren't the only thing Nefty's UI was wrapping.
        <strong>Drops</strong> are the "claim an NFT, pay 50 WAX,
        mint delivered to your wallet" feature. They live in a
        separate contract called <code>neftyblocksd</code>. Same
        story: the contract is still alive on-chain, only the
        website is gone.
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
        asset_ids to <code>claimwproof</code>.</li>
        <li><strong>Authkey</strong> (signed message). The drop
        creator gives each user a signed key off-chain. Without
        that key the contract refuses; Crucible can't help here.</li>
      </ul>
      <p>
        When a drop is <em>paid</em>, two more actions lead the
        transaction:
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
];

/**
 * Renders all panels as a `<section class="about">` so the cyberpunk
 * theme can target them with a single selector. The wrapper appears
 * first on the page; the rest of the app renders below.
 */
export function renderAboutPanels(): string {
  return `
    <section class="about">
      <h2>0 · About this tool</h2>
      ${PANELS.map(
        (p) => `
        <details class="about-panel"${p.open ? ' open' : ''}>
          <summary><span>${p.summary}</span></summary>
          <div class="about-body">${p.body}</div>
        </details>`,
      ).join('')}
    </section>`;
}
