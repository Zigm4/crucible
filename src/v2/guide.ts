/**
 * The user guide, as a page of v2.
 * ─────────────────────────────────────────────────────────────
 * It used to be a standalone page in the classic skin (guide.html), written
 * around the classic tabs, and parts of it had gone wrong as the tools moved
 * on: creating a recipe was "on a separate screen, ask the maintainer",
 * gated upgrades were "not executable", random blends took "two
 * signatures", a whitelisted drop "starts empty". Every statement here was
 * checked against the code on 2026-10-24; when a tool changes, the section
 * that describes it changes with it.
 *
 * Sections are addressed as #/guide/<id>. The hash belongs to the router,
 * so an ordinary #id anchor would leave the page: the table of contents and
 * every "Back to contents" link use those addresses, and app.ts scrolls to
 * the section once the page is painted (scrollGuide).
 */

type Group = 'start' | 'use' | 'wallet' | 'author' | 'help';

interface Section {
  id: string;
  group: Group;
  title: string;
  /** One line for the table of contents. */
  blurb: string;
  body: string;
}

const GROUPS: { group: Group; title: string; icon: string }[] = [
  { group: 'start', title: 'Start here', icon: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>' },
  { group: 'use', title: 'Use recipes', icon: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>' },
  { group: 'wallet', title: 'Your wallet', icon: '<rect x="3" y="6" width="18" height="14" rx="2.5"/><path d="M16 13h2M3 10h18M7 6V4.5h10V6"/>' },
  { group: 'author', title: 'For collection authors', icon: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>' },
  { group: 'help', title: 'Help and reference', icon: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/>' },
];

const note = (html: string, tone: 'info' | 'warn' | 'ok' = 'info') => `<div class="v2-guide-note ${tone}">${html}</div>`;
const steps = (items: string[]) => `<ol class="v2-guide-steps">${items.map((i) => `<li>${i}</li>`).join('')}</ol>`;
const go = (href: string, label: string) => `<a class="v2-guide-go" href="${href}">${label} →</a>`;

const SECTIONS: Section[] = [
  {
    id: 'start', group: 'start', title: 'Before you start',
    blurb: 'A wallet, a little CPU, and nothing else',
    body: `
      <p>Crucible is one open-source page that talks straight to the smart contracts NeftyBlocks,
      WaxDAO and the Blenderizer left running on WAX. Their websites closed; the contracts never
      stopped. You need nothing to look around, and three things to sign.</p>
      ${steps([
        '<strong>A wallet.</strong> Anchor or WAX Cloud Wallet: <em>Connect wallet</em> on the home page. Connecting only tells the page who you are; nothing moves until you approve a transaction in your wallet.',
        '<strong>A little CPU and NET.</strong> Every transaction uses some of your account\'s resources, and the sponsor NeftyBlocks used to provide no longer signs. Keep roughly <strong>5 to 10 WAX staked to CPU</strong>, and a little to NET, from your wallet\'s resources screen. A blend uses about 1.5 ms of CPU. WAX Cloud Wallet often covers small transactions for you.',
        '<strong>A theme, if you like.</strong> Light or Dark, top right. It is remembered on this device.',
      ])}
      ${note('<strong>Looking needs no wallet.</strong> Recipes, collections, any account\'s NFTs or staking, name auctions: all of it is public chain data, readable before you connect.', 'ok')}`,
  },
  {
    id: 'safety', group: 'start', title: 'How Crucible keeps you safe',
    blurb: 'What happens between your click and your signature',
    body: `
      <p>Every button that signs something goes through the same four steps, in this order. Only the
      last one is yours.</p>
      ${steps([
        '<strong>Crucible reads the chain.</strong> The recipe, its status and supply, its limits per wallet, its whitelist or holder rule, and what your wallet holds. A recipe you cannot run says why, in plain words, before you click anything.',
        '<strong>Crucible builds the transaction.</strong> The exact actions your wallet will show you, built from the contract\'s own definition.',
        '<strong>The chain is asked first.</strong> The transaction is run by a WAX node as a rehearsal: executed for real against the live contracts, but never signed and never written. If a contract would refuse it, you see the contract\'s own reason and <strong>your wallet does not even open</strong>.',
        '<strong>Your wallet asks you.</strong> It shows every action. You approve or decline; the page never sees a key.',
      ])}
      <p>The rehearsal has four possible answers:</p>
      <ul class="v2-guide-list">
        <li><strong>Accepted</strong>: it would go through. Your wallet opens.</li>
        <li><strong>Refused</strong>: a contract said no. The reason is shown and nothing is signed.</li>
        <li><strong>Resources</strong>: your account's own CPU or NET would not cover it. That is not a refusal: a wallet that pays for its users (WAX Cloud Wallet, a resource provider) adds its payment when it signs, so you can still go ahead.</li>
        <li><strong>No answer</strong>: no node replied within 15 seconds. Nothing is known either way, and signing is left to you.</li>
      </ul>
      ${note('<strong>What Crucible never does:</strong> hold your keys, sign for you, take a fee, or send anything anywhere but the WAX contracts you approve. There is no Crucible server: the page is a static file, and its whole source is <a href="https://github.com/Zigm4/crucible" target="_blank" rel="noreferrer">on GitHub</a>.', 'ok')}`,
  },
  {
    id: 'use', group: 'use', title: 'Use a recipe',
    blurb: 'Four questions, from what to do to what you sign',
    body: `
      <p><em>Use a recipe</em> starts from what you want to do. You never need to know which contract
      runs it: Crucible searches all of them.</p>
      ${steps([
        '<strong>What?</strong> Blend NFTs, upgrade an NFT, claim a drop, or open a pack.',
        '<strong>Where?</strong> Pick a collection, typed or chosen from the ones you hold.',
        '<strong>Which one?</strong> Every recipe of that kind in the collection, each with its verdict: whether you can run it now, and if not, why.',
        '<strong>Check.</strong> What it costs, what you get, which of your NFTs go in (picked for you, changeable), and the button to sign.',
      ])}
      <p>A recipe you cannot run is shown, greyed and not clickable, with the reason: ended, sold out,
      your limit reached, not on its whitelist, an ingredient missing. Under anything you are short of,
      a link opens it on AtomicHub, the market where it can be bought.</p>
      ${note('Prefer to start from a collection? <a href="#/explore">Explore</a> shows everything one collection offers on a single page.')}
      ${go('#/use', 'Use a recipe')}`,
  },
  {
    id: 'blends', group: 'use', title: 'Blends',
    blurb: 'Give NFTs (and sometimes tokens), get something new',
    body: `
      <p>A blend takes NFTs, and sometimes a token amount, and mints a result. Three platforms run
      blends, and <em>Blend NFTs</em> searches them together: NeftyBlocks (<code>blend.nefty</code>),
      WaxDAO (<code>waxdaomarket</code>) and the Blenderizer (<code>blenderizerx</code>).</p>
      <ul class="v2-guide-list">
        <li><strong>A fixed result</strong> is minted in the same transaction you sign.</li>
        <li><strong>A random result</strong> is drawn by the WAX oracle a few seconds after you sign, and the contract mints it to you on its own. Crucible waits and shows what you got. If a draw ever waits for a second signature, Crucible offers it.</li>
        <li><strong>Gated blends</strong> are handled: a whitelist (your account must be on it) or a holder rule (you must hold certain NFTs or tokens; Crucible picks the NFTs that prove it, and never one that the blend itself consumes).</li>
        <li><strong>Ingredients that must hold a token balance</strong> are supported: Crucible checks the NFT holds enough.</li>
      </ul>
      <p>Each ingredient says what happens to it: most are <strong>burned</strong>, some are sent to an
      account the author chose. Either way they leave your wallet; the Check step says which.</p>
      ${note('<strong>Not handled:</strong> blends with a time gate (an NFT must have waited a while) or a "chest" ingredient. Crucible says so on the recipe rather than letting you try.', 'warn')}
      ${note('<strong>Blenderizer:</strong> the simplest of the three. One signature, no odds, no whitelist. It mints from RAM the collection pre-paid, so a collection without RAM there cannot pay out until its author tops it up; Crucible checks that before you send anything.')}`,
  },
  {
    id: 'upgrades', group: 'use', title: 'Upgrades',
    blurb: 'Keep your NFT, change what it says',
    body: `
      <p>An upgrade (<code>up.nefty</code>) rewrites attributes of an NFT you keep: a level, a colour,
      a rarity. You pick the NFT to upgrade, Crucible checks it qualifies (by template, or by the value
      of an attribute), and you pay the cost: other NFTs, a token amount, or both.</p>
      <ul class="v2-guide-list">
        <li>The Check step shows the attribute as it is, and as it will be.</li>
        <li>Upgrades behind a whitelist or a holder rule are signed the right way for each.</li>
        <li>Many upgrades carry a small <strong>0.01 WAX line paid to fees.nefty</strong>: NeftyBlocks' own fee, which its contract requires. It is not Crucible's.</li>
      </ul>`,
  },
  {
    id: 'drops', group: 'use', title: 'Drops',
    blurb: 'Claim or buy fresh mints',
    body: `
      <p>A drop (<code>neftyblocksd</code>) mints new NFTs when you claim it, free or for a price.
      Crucible signs every kind a player can sign:</p>
      <ul class="v2-guide-list">
        <li><strong>Public</strong>: open to anyone.</li>
        <li><strong>Whitelist</strong>: your account must be on the drop's list. Some lists also give each account its own claim limit.</li>
        <li><strong>Holders</strong>: you must hold certain NFTs or tokens. Crucible picks the NFTs that prove it, and says exactly what is required when you do not.</li>
      </ul>
      <p>The Check step shows the price in the token the drop asks for, the per-wallet limit and what
      you have already claimed.</p>
      ${note('<strong>Key-gated drops</strong> need a one-time secret only their creator can issue: no outside tool can sign those.', 'warn')}`,
  },
  {
    id: 'packs', group: 'use', title: 'Packs',
    blurb: 'Open a pack you own, safely, in two signatures',
    body: `
      <p><em>Open a pack</em> lists the packs your wallet holds from both pack contracts, AtomicHub's
      (<code>atomicpacksx</code>) and NeftyBlocks' (<code>neftyblocksp</code>). Opening one takes two
      signatures:</p>
      ${steps([
        '<strong>Send the pack</strong> to its contract.',
        '<strong>Wait a few seconds</strong> while the WAX oracle draws the cards. Crucible shows what was drawn.',
        '<strong>Sign once more</strong> to mint them into your wallet.',
      ])}
      ${note('<strong>Interrupted between the two?</strong> Nothing is lost: the pack is held by its contract, waiting. Crucible finds packs you sent but never finished, whichever page you started on, and offers the second signature.', 'ok')}`,
  },
  {
    id: 'explore', group: 'use', title: 'Explore a collection',
    blurb: 'Everything one collection offers, on one page',
    body: `
      <p><em>Explore</em> starts from a collection instead of an action: every blend, upgrade, drop and
      pack it offers, across all contracts, as cards with their artwork. Each card carries the same
      verdict as the Check step, so you see at a glance what you can make, claim or open right now.</p>
      <ul class="v2-guide-list">
        <li>Group the cards by type of result or by contract, show them small, medium or large, as a grid or a list. Your choice is remembered.</li>
        <li>The figures at the top count what the collection offers, and what you can do now.</li>
        <li>A card opens the recipe at its Check step.</li>
      </ul>
      ${go('#/explore', 'Explore a collection')}`,
  },
  {
    id: 'nfts', group: 'wallet', title: 'My NFTs',
    blurb: 'Everything you own, and what each NFT is good for',
    body: `
      <p><em>My NFTs</em> reads every NFT a wallet owns once, then searches and filters it instantly:
      by collection, schema, template or attribute, with filters you can save and bring back. Any
      account can be looked at, not just yours.</p>
      <ul class="v2-guide-list">
        <li>Open an NFT to see <strong>what it is good for</strong>: the pack it opens, the blends that take it, the upgrades it qualifies for or pays into. Each answer opens that recipe, one click away. This looks in the NFT's own collection, which is where its recipes almost always live.</li>
        <li><strong>Tokens</strong> lists the wallet's token balances too.</li>
      </ul>
      ${go('#/nfts', 'Open My NFTs')}`,
  },
  {
    id: 'staking', group: 'wallet', title: 'Staking: get back what you staked',
    blurb: 'stake.nefty and WaxDAO still hold tokens and NFTs',
    body: `
      <p>NeftyBlocks' and WaxDAO's websites are gone, but their staking contracts still hold what
      people put in, and still pay it out. <em>Staking</em> reads what they hold for your wallet and
      walks you through taking it back.</p>
      <h3>NeftyBlocks · stake.nefty</h3>
      ${steps([
        '<strong>Claim your rewards first.</strong> The WAX reward pot holds less than it owes and pays whoever asks first: the page shows how much of it is covered.',
        '<strong>Unstake.</strong> Your stake itself is fully backed. NEFTY then waits out the contract\'s delay (about 3 days); NEFWAX comes back at once.',
        '<strong>Collect what finished unstaking.</strong> Nothing returns on its own: this second step is the one people forget.',
      ])}
      <p>A pool retired in 2022 is shown apart, with why nothing can be taken from it.</p>
      <h3>WaxDAO</h3>
      <p>NFT farms (old and new), token pools and farms, DAO staking, token locks, token-backed NFTs,
      and what a creator left on the market. Each line has its buttons, always in the same place: Claim
      on the left, Unstake (or Withdraw) on the right.</p>
      <ul class="v2-guide-list">
        <li><strong>All farms at once</strong>: every farm's rewards in one signature, and farms unstaked eight per signature.</li>
        <li>A reward paid in a token you have never held needs that token "opened" in your wallet first; Crucible adds that step for you.</li>
        <li>Some farms pay from a contract that no longer exists: your NFTs come back, their rewards cannot. Where WaxDAO refuses even that, the line says so and offers no button.</li>
        <li>Right after you sign, the line shows <strong>Signed, waiting for the chain to show it</strong>, and offers nothing to sign again until it is gone.</li>
      </ul>
      ${note('Anyone can check a wallet: type an account in <em>Look</em>, or use <code>#/stake/account.wam</code>. Someone else\'s holdings are read only.')}
      ${go('#/stake', 'Open Staking')}`,
  },
  {
    id: 'names', group: 'wallet', title: 'WAX names',
    blurb: 'Premium name auctions: bid, follow, claim',
    body: `
      <p>A WAX account name shorter than 12 characters, without a dot, cannot simply be created: it is
      sold by an open auction run by the system contract itself. <em>WAX names</em> reads that auction
      and bids on it.</p>
      <ul class="v2-guide-list">
        <li><strong>A bid must beat the current one by at least 10%.</strong> Your WAX leaves your account when you bid.</li>
        <li><strong>Outbid? You are refunded, but not automatically:</strong> the refund waits for you to claim it, and the page offers every one you have in a single signature.</li>
        <li><strong>Once a day the chain closes the single highest auction</strong> whose top bid has stood for 24 hours. Leading a name is not winning it: the page shows where your bid stands in that chain-wide queue.</li>
        <li><strong>Won it?</strong> The account still has to be created: the page builds that transaction, with your own keys by default.</li>
      </ul>
      ${go('#/names', 'Open WAX names')}`,
  },
  {
    id: 'create', group: 'author', title: 'Create a recipe',
    blurb: 'Blends, upgrades and drops for your collection',
    body: `
      <p>If your wallet is one of a collection's <strong>authorized accounts</strong>, <em>Create</em>
      makes blends, upgrades and drops for it, one question per screen.</p>
      ${steps([
        '<strong>What, and where:</strong> the kind of recipe and your collection.',
        '<strong>What players give:</strong> NFTs picked from your own templates and schemas, with their artwork, or a token amount. Each NFT is burned or sent to an account you name.',
        '<strong>What they get:</strong> for a blend, one or several outcomes with their odds drawn as a bar; for an upgrade, the attributes to rewrite, their types read from your schema; for a drop, the templates to mint and the price, in any token the drop contract accepts, or free.',
        '<strong>Any limits:</strong> start and end, total uses or supply, a limit per wallet, and who can use it (see below).',
        '<strong>Review:</strong> the recipe as one sentence, every check, then <em>Simulate</em> (the rehearsal) and <em>Sign and create</em>.',
      ])}
      <h3>Who can use it</h3>
      <ul class="v2-guide-list">
        <li><strong>Everyone.</strong></li>
        <li><strong>A list of accounts</strong>, made with the recipe, in the same transaction. Paste accounts in any format: each is looked up on chain, repeats and typos are caught before you sign. A drop's list can give each account a claim limit, which can only lower the drop's own.</li>
        <li><strong>Holders</strong>: whoever holds NFTs of a template, a schema or a collection, or a token amount, with "all of these" or "any one of these". A drop can have a list and a holder rule together.</li>
      </ul>
      ${note('<strong>Create it hidden first.</strong> It exists on chain but appears in no list: test it with one NFT, then reveal it from Change. Creation is permanent and costs RAM.', 'ok')}
      ${note('<strong>Upgrades below level 3 of NEFTY staking</strong> must carry NeftyBlocks\' fixed fee (0.01 WAX to fees.nefty) and at least one other ingredient, or the contract refuses them. The creator says so and adds the fee line in one click.', 'warn')}
      <p>Crucible also checks that your collection has authorized the contract it is creating on:
      without that, nobody could ever run the recipe. If it has not, add the contract on AtomicHub
      first.</p>
      ${go('#/create', 'Open Create')}`,
  },
  {
    id: 'change', group: 'author', title: 'Change what you made',
    blurb: 'Edit, pause, reschedule, gate or delete',
    body: `
      <p><em>Change something you made</em> lists your collection's blends, upgrades and drops, hidden
      and ended ones included. Opening one reads it whole from the chain, so every field starts from
      what it really holds, and only what you touch is signed.</p>
      <ul class="v2-guide-list">
        <li>Name, description, image, category, price (drops), time window, total uses or supply, limit per wallet, hidden or visible.</li>
        <li><strong>What players give</strong> (blends and upgrades): edited as rows, written back only if you changed them. A recipe whose ingredients the editor cannot reproduce exactly shows why and leaves them untouched.</li>
        <li><strong>Who can use it</strong>: move a recipe to another list or holder rule; add or take accounts off a list (one by one, pasted, or "start over"); rewrite a holder rule; open a drop to everyone.</li>
        <li><strong>Your collection's lists and holder rules</strong>: what each holds, which recipes share it (a change to it reaches all of them), and a delete button for the ones nothing uses, offered only when the chain accepts it.</li>
        <li><strong>Delete</strong> a recipe outright. That one cannot be undone.</li>
      </ul>
      ${note('<strong>What no contract lets an author change:</strong> a blend\'s outcomes, an upgrade\'s attribute rewrites, the templates a drop mints. Changing those means deleting the recipe and creating a new one.', 'warn')}`,
  },
  {
    id: 'trouble', group: 'help', title: 'When something goes wrong',
    blurb: 'The messages you may see, and what to do',
    body: `
      <dl class="v2-guide-faq">
        <dt>"The chain would refuse it, so your wallet was not opened"</dt>
        <dd>The rehearsal caught a refusal before you signed anything. The words after it are the contract's own: a limit reached, not on the whitelist, not started yet, sold out, an ingredient missing.</dd>
        <dt>"exceeded the account CPU limit", or a resources warning</dt>
        <dd>Your account is short of CPU or NET. Stake a few more WAX to CPU in your wallet and try again.</dd>
        <dt>"greymassfuel@cosign … does not have signatures for it"</dt>
        <dd>Your wallet tried to borrow CPU through Greymass Fuel and was not cosigned. Stake a few WAX to CPU, or sign with WAX Cloud Wallet. It is not a Crucible error.</dd>
        <dt>"The collection does not have enough RAM to mint the assets"</dt>
        <dd>The collection has not deposited the RAM its drops mint from. Nobody can claim until its author tops it up: tell them.</dd>
        <dt>"Crucible does not handle this recipe"</dt>
        <dd>The recipe uses a time gate or a "chest" ingredient. Crucible says so instead of letting a transaction fail.</dd>
        <dt>A random blend shows no result yet</dt>
        <dd>The oracle draws a few seconds after you sign, and the contract mints the result itself. Crucible keeps watching; if a draw waits for you, it offers the claim.</dd>
        <dt>A pack opened halfway</dt>
        <dd>Safe: the pack waits in its contract. Open the pack tool again and Crucible offers the second signature.</dd>
        <dt>No artwork</dt>
        <dd>Images come from public image servers that are sometimes down. The recipe works the same without them.</dd>
      </dl>`,
  },
  {
    id: 'links', group: 'help', title: 'Shareable links',
    blurb: 'Every page has an address you can paste',
    body: `
      <p>Every screen keeps its own address, so you can bookmark it or paste it to anyone. Nobody needs
      a wallet to read what it shows.</p>
      <ul class="v2-guide-list v2-guide-links">
        <li><code>#/explore/underpunks55</code> everything a collection offers</li>
        <li><code>#/nfts/account.wam</code> a wallet's NFTs</li>
        <li><code>#/stake/account.wam</code> what a wallet has staked</li>
        <li><code>#/names/rekt</code> a name auction</li>
        <li><code>#/guide/staking</code> a section of this guide</li>
      </ul>
      <p>A recipe open at its Check step has its own address too. Links from the classic version, such
      as <code>#/nefty/blend/43444</code>, open the same recipe here.</p>`,
  },
  {
    id: 'classic', group: 'help', title: 'The classic version',
    blurb: 'The original page, still there',
    body: `
      <p>The first version of Crucible is still online, at the root of the site, one dense panel per
      contract. It reads the same chain and signs the same transactions. The <em>Classic version</em>
      link at the top of every page opens the same screen there.</p>
      <p>Two things live only there for now: the <strong>contract status</strong> page, which checks that
      each contract is up and unchanged, and the expert panels that take a raw recipe id.</p>
      ${go('../', 'Open the classic version')}`,
  },
  {
    id: 'privacy', group: 'help', title: 'Privacy',
    blurb: 'What your browser talks to, and what it never sends',
    body: `
      <ul class="v2-guide-list">
        <li><strong>No account, no server, no database, no tracking.</strong> Crucible is a static page; nothing you do is sent to it, because there is nothing to send to.</li>
        <li>To read the chain, your browser talks directly to <strong>public WAX nodes and the AtomicAssets indexer</strong>, and fetches NFT artwork from public image servers. Like any website, those see your IP address and what you ask them for.</li>
        <li><strong>Your keys never leave your wallet.</strong> Anchor and WAX Cloud Wallet sign on their side.</li>
        <li><strong>No cut.</strong> The fees the contracts always charged still go where they always went; Crucible adds none.</li>
        <li><strong>Open source</strong> under the MIT licence: read it, fork it, host your own copy.</li>
      </ul>`,
  },
];

export const GUIDE_IDS = SECTIONS.map((s) => s.id);

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export function renderGuide(): string {
  const toc = GROUPS.map((g) => `
    <div class="v2-guide-tocgroup">
      <h2><span class="v2-group-icon">${icon(g.icon)}</span>${esc(g.title)}</h2>
      <div class="v2-guide-tocitems">
        ${SECTIONS.filter((s) => s.group === g.group).map((s) => `
          <a class="v2-guide-tocitem" href="#/guide/${s.id}">
            <strong>${esc(s.title)}</strong>
            <small>${esc(s.blurb)}</small>
          </a>`).join('')}
      </div>
    </div>`).join('');

  const sections = SECTIONS.map((s) => {
    const g = GROUPS.find((x) => x.group === s.group)!;
    return `
      <section class="v2-guide-section" id="guide-${s.id}">
        <p class="v2-eyebrow">${esc(g.title)}</p>
        <h2>${esc(s.title)}</h2>
        <div class="v2-guide-body">${s.body}</div>
        <a class="v2-guide-back" href="#/guide/contents">↑ Back to contents</a>
      </section>`;
  }).join('');

  return `
    <div class="v2-guide">
      <div class="v2-hero v2-guide-hero">
        <p class="v2-eyebrow">User guide</p>
        <h1>How Crucible works</h1>
        <p class="v2-lead">Everything you can do here, step by step, and what happens at each one. The short
        version: you can look at everything without a wallet, the chain is asked before your wallet ever
        opens, and only you sign.</p>
        <div class="v2-guide-promises">
          <div><strong>Your keys stay in your wallet</strong><span>Crucible builds transactions; your wallet shows and signs them.</span></div>
          <div><strong>The chain answers first</strong><span>Every transaction is rehearsed: a refusal never reaches your wallet.</span></div>
          <div><strong>No server, no fee</strong><span>A static, open-source page. Nothing is sent to us, nothing is taken.</span></div>
        </div>
      </div>
      <nav class="v2-guide-toc" id="guide-contents" aria-label="Contents">
        <h2 class="v2-guide-toctitle">Contents</h2>
        ${toc}
      </nav>
      ${sections}
      <p class="v2-guide-end">Something missing or unclear? Ask on the Crucible Discord, or open an issue on
        <a href="https://github.com/Zigm4/crucible" target="_blank" rel="noreferrer">GitHub</a>.</p>
    </div>`;
}

/** Brings a section, or the contents, into view. Called after each paint of the guide. */
export function scrollGuide(section: string): void {
  const el = document.getElementById(section && section !== 'contents' ? `guide-${section}` : 'guide-contents');
  if (el && (section || el.getBoundingClientRect().top < 0)) el.scrollIntoView({ block: 'start' });
}
