/**
 * Getting your tokens out of stake.nefty, in the order that loses nothing.
 * ─────────────────────────────────────────────────────────────
 * NeftyBlocks' site is gone and stake.nefty still pays. The classic page
 * shows everything it holds for a wallet, pool by pool. This page asks
 * the same contract the same questions (ui/stakingView, nefty/staking)
 * and lays the answer out as the three things to do, in order:
 *
 *   1. claim the rewards     the WAX pot is short and pays first come,
 *                            first served, so this one is a race
 *   2. unstake               the principal is fully backed; on the NEFTY
 *                            pool it then waits out the contract's delay
 *   3. collect the refund    nothing returns it on its own, and refunds
 *                            on this contract have sat unclaimed since 2022
 *
 * A pool retired in 2022 is shown apart, with why nothing can be signed
 * for it. Collections staked by this wallet, an author's matter with its
 * own consequence, come last.
 *
 * Every button asks the chain first (chain/simulate): a refusal is shown
 * with the contract's reason and the wallet never opens for it.
 */
import type { BuiltAction } from '../chain/action';
import { getCurrentSession } from '../chain/session';
import { simulateActions } from '../chain/simulate';
import {
  claimAllFarms, FARMS_PER_TRANSACTION, readWaxdaoHoldings, unstakeManyFarms,
  type HoldingGroup, type WaxdaoHolding,
} from '../waxdao/holdings';
import {
  buildClaimFor, buildCollectionRefundFor, buildCollectionUnstakeFor, buildRefundFor, buildUnstakeFor,
  collectionLosesUpgradeRight, emptyStakingState, isUnprovenPool, loadStaking, poolShortfall,
  refundDelayFor, tokenContractFor, type StakingState,
} from '../ui/stakingView';

const st: StakingState = emptyStakingState();
/** WaxDAO, read for one wallet (waxdao/holdings). */
const wd: { actor: string; loading: boolean; loaded: boolean; items: WaxdaoHolding[]; error: string } =
  { actor: '', loading: false, loaded: false, items: [], error: '' };
/** The transactions behind the WaxDAO buttons on screen, by button key. */
const wdActions = new Map<string, BuiltAction[]>();
/** The one action in flight, by its key, and how far it got. */
let doing: { key: string; phase: 'checking' | 'signing' } | undefined;
/**
 * Whose holdings are on screen. Any account can be looked at, the way the
 * inventory can: the chain is public. Only the connected wallet signs, so
 * the buttons are drawn for it alone.
 */
let viewing = '';
const canSign = () => Boolean(viewing) && viewing === String(getCurrentSession()?.actor ?? '');

/** How the last action ended, shown under its own button. */
let outcome: { key: string; kind: 'done' | 'refused' | 'failed'; text: string; trx?: string } | undefined;

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const when = (t: number) => new Date(t * 1000).toLocaleString();

function ensureLoaded(repaint: () => void, actor: string): void {
  if (!actor) return;
  if (!st.loading && !(st.loaded && st.actor === actor)) {
    void loadStaking(st, actor).then(repaint).catch((e: unknown) => {
      st.loading = false;
      st.error = e instanceof Error ? e.message : String(e);
      repaint();
    });
  }
  if (!wd.loading && !(wd.loaded && wd.actor === actor)) {
    wd.loading = true;
    wd.actor = actor;
    wd.loaded = false;
    wd.error = '';
    void readWaxdaoHoldings(actor)
      .then((items) => { if (wd.actor === actor) { wd.items = items; wd.loaded = true; } })
      .catch((e: unknown) => { wd.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { wd.loading = false; repaint(); });
  }
}

/** A button that asks the chain, then the wallet, with its own status line. */
function action(key: string, label: string, data: string, note = ''): string {
  // Someone else's holdings: what would be signed, and nothing to press.
  if (!canSign()) return `<span class="v2-chip v2-stake-would" title="Only ${esc(viewing)} can sign this">${esc(label)}</span>`;
  const busy = doing?.key === key;
  const out = outcome?.key === key ? outcome : undefined;
  return `
    <div class="v2-stake-act">
      <button class="lab-primary" data-stake-act="${esc(key)}" ${data} ${doing ? 'disabled' : ''}>
        ${busy ? (doing!.phase === 'checking' ? 'Checking with the chain' : 'Waiting for your wallet') : esc(label)}
      </button>
      ${note ? `<span class="lab-hint">${note}</span>` : ''}
      ${out?.kind === 'done' ? `<p class="lab-ok">Signed. <a target="_blank" rel="noreferrer"
          href="https://waxblock.io/transaction/${esc(out.trx ?? '')}">view it on waxblock</a></p>` : ''}
      ${out?.kind === 'refused' ? `<p class="lab-warn">The chain would refuse it, so your wallet was not opened: ${esc(out.text)}</p>` : ''}
      ${out?.kind === 'failed' ? `<p class="lab-warn">Not signed: ${esc(out.text)}</p>` : ''}
    </div>`;
}

function step(n: number, title: string, status: 'now' | 'wait' | 'done', body: string): string {
  const badge = status === 'done' ? 'Nothing to do' : status === 'wait' ? 'Waiting' : 'To do';
  return `
    <li class="v2-step v2-step-${status}">
      <div class="v2-step-head">
        <span class="v2-step-n">${status === 'done' ? '✓' : n}</span>
        <h2>${esc(title)}</h2>
        <span class="v2-step-badge">${badge}</span>
      </div>
      <div class="v2-step-body">${body}</div>
    </li>`;
}

export function renderStake(repaint: () => void, walletLine: string, subject = ''): string {
  const actor = subject || String(getCurrentSession()?.actor ?? '');
  viewing = actor;
  ensureLoaded(repaint, actor);
  const head = `
    <div class="v2-explore-head">
      <div>
        <p class="v2-eyebrow">Staking · NeftyBlocks and WaxDAO</p>
        <h1>Get back what you staked</h1>
        <p class="v2-lead">NeftyBlocks' and WaxDAO's websites are gone; their staking contracts still pay out.
        This reads what they hold for your wallet and walks you through taking it back.</p>
      </div>
    </div>`;
  if (!actor) return `<section class="v2-explore v2-stake">${head}${walletLine}${lookup()}</section>`;
  const other = !canSign();
  return `<section class="v2-explore v2-stake">${head}
    ${other ? `<p class="lab-warn">Showing <code>${esc(actor)}</code>, read only. Connect as this account to take anything back.</p>` : ''}
    ${lookup()}
    <section class="v2-stake-block">
      <h2 class="v2-stake-block-title">NeftyBlocks · stake.nefty</h2>
      ${renderNefty(actor)}
    </section>
    <section class="v2-stake-block">
      <h2 class="v2-stake-block-title">WaxDAO · farms, pools, DAOs, locks</h2>
      ${renderWaxdao(actor)}
    </section>
  </section>`;
}

/** Look at another account's holdings, read only. */
function lookup(): string {
  return `<form class="v2-explore-pick v2-stake-lookup" data-stake-lookup>
    <input name="account" placeholder="Look at another account, e.g. somebody.wam" autocomplete="off" />
    <button type="submit">Look</button>
  </form>`;
}

/** stake.nefty for this wallet, as the three steps. */
function renderNefty(actor: string): string {
  if (!st.loaded || st.actor !== actor) {
    return `<p class="lab-hint">Reading what <code>${esc(actor)}</code> has in stake.nefty.</p>
      ${st.error ? `<p class="v2-error">${esc(st.error)}</p>` : ''}`;
  }

  const real = st.positions.filter((p) => p.staked > 0 || p.refunding > 0 || p.rewards > 0);
  const live = real.filter((p) => !isUnprovenPool(p, st.pools));
  const retired = real.filter((p) => isUnprovenPool(p, st.pools));
  const toClaim = live.filter((p) => p.rewards > 0);
  const toUnstake = live.filter((p) => p.staked > 0 && tokenContractFor(p, st.pools));
  const ready = st.refunds.filter((r) => r.ready);
  const waiting = st.refunds.filter((r) => !r.ready);
  const nothing = !real.length && !st.refunds.length && !st.collections.length && !st.collectionRefunds.length;
  if (nothing) {
    return `<p class="lab-hint">Nothing in stake.nefty: no stake, no rewards, no unfinished unstake,
      and no collection staked under this wallet.</p>`;
  }

  // Step 1: the race.
  const claimBody = toClaim.length ? toClaim.map((p) => {
    const row = st.pools.find((x) => x.stakedSymbol === p.stakedSymbol);
    const short = row ? poolShortfall(row) : undefined;
    return `
      <div class="v2-stake-card">
        <strong>${esc(p.rewardsRaw)}</strong> waiting in the ${esc(p.stakedSymbol)} pool
        ${short ? `<p class="lab-warn">This pot is short: it holds ${esc(row!.heldBalance)} against
          ${esc(row!.rewardsBalance)} owed, ${short.coverage}% of it, and pays whoever asks first until it is
          empty. Claim before anything else.</p>` : ''}
        ${action(`claim:${p.scope}`, `Claim ${p.rewardsRaw}`, `data-scope="${esc(p.scope)}" data-kind="claim"`, 'Paid on the spot.')}
      </div>`;
  }).join('') : '<p class="lab-hint">No rewards waiting.</p>';

  // Step 2: the principal.
  const raceOpen = toClaim.some((p) => {
    const row = st.pools.find((x) => x.stakedSymbol === p.stakedSymbol);
    return Boolean(row && poolShortfall(row));
  });
  const unstakeBody = toUnstake.length ? toUnstake.map((p) => {
    const d = refundDelayFor(p, st.pools);
    const delay = d === undefined ? ''
      : d === 0 ? 'Comes back in the same transaction, nothing to collect later.'
        : `Then waits ${Math.round(d / 86400)} days, and comes back only when you collect it (step 3).`;
    return `
      <div class="v2-stake-card">
        <strong>${esc(p.stakedRaw)}</strong> staked in the ${esc(p.stakedSymbol)} pool
        ${raceOpen ? '<p class="lab-hint">Claim the rewards first: unstaking is not a race, the claim is.</p>' : ''}
        ${action(`unstake:${p.scope}`, 'Unstake everything', `data-scope="${esc(p.scope)}" data-kind="unstake"`, esc(delay))}
      </div>`;
  }).join('') : '<p class="lab-hint">Nothing left staked.</p>';

  // Step 3: the second transaction people forget.
  const refundBody = `${ready.map((r) => `
      <div class="v2-stake-card">
        <strong>${esc(r.quantity)}</strong> finished unstaking
        ${action(`refund:${r.id}`, 'Take it back', `data-id="${r.id}" data-kind="refund"`)}
      </div>`).join('')}
    ${waiting.map((r) => `
      <div class="v2-stake-card v2-stake-wait">
        <strong>${esc(r.quantity)}</strong> unstaking, ready ${esc(when(r.unlockTime))}.
        <p class="lab-hint">Come back then: nothing returns it on its own.</p>
      </div>`).join('')}
    ${!ready.length && !waiting.length ? '<p class="lab-hint">Nothing waiting to be collected.</p>' : ''}`;

  const times = st.pools.map((p) => p.nextRewardTime).filter((t) => t > 0);
  const stoppedAt = times.length ? Math.max(...times) : 0;
  const stopped = stoppedAt && Date.now() / 1000 - stoppedAt > 86400
    ? `<p class="lab-warn">Nothing has accrued since ${esc(when(stoppedAt))}: the reward cycles stopped and only
       NeftyBlocks could restart them. Staying staked earns nothing; what you were owed is still payable.</p>` : '';

  const retiredBody = retired.length ? `
    <div class="v2-stake-card v2-stake-lost">
      <strong>${retired.map((p) => esc(p.stakedRaw)).join(', ')}</strong> in the retired pool
      <p class="lab-hint">This pool was shut on 4 October 2022 and its reward row deleted. Every unstake or claim on
      it stops at "The reward pool does not exist" before anything moves, and the token now has a supply of zero,
      so there is nothing to send back. No button is offered because none could work.</p>
    </div>` : '';

  const collectionsBody = st.collections.length || st.collectionRefunds.length ? `
    <section class="v2-stake-section">
      <h2>Collections you staked for</h2>
      <p class="lab-hint">Not your own stake: it belongs to the collection and sets its tier.</p>
      ${st.collections.map((c) => {
        const loses = collectionLosesUpgradeRight(c, st.tierGrantsUpgrade);
        return `
        <div class="v2-stake-card">
          <strong>${esc(c.collection)}</strong> · ${esc(c.level || 'no tier')} · ${esc(c.stakedRaw || '0')} staked
          ${c.refunding > 0 ? ` · ${esc(c.refundingRaw)} unstaking` : ''}
          ${loses ? `<p class="lab-warn">Unstaking drops this tier, which is what lets up.nefty accept an upgrade
            with a single ingredient. Upgrades that already exist keep working.</p>` : ''}
          ${c.staked > 0 && c.tokenContract && c.author === actor
            ? action(`unstakecoll:${c.collection}`, `Unstake ${c.stakedRaw}`, `data-collection="${esc(c.collection)}" data-kind="unstakecoll"`)
            : ''}
        </div>`;
      }).join('')}
      ${st.collectionRefunds.map((r) => `
        <div class="v2-stake-card ${r.ready ? '' : 'v2-stake-wait'}">
          <strong>${esc(r.quantity)}</strong> from ${esc(r.collection)}, ${r.ready ? 'ready now' : `ready ${esc(when(r.unlockTime))}`}
          ${r.ready ? action(`refundcoll:${r.id}`, 'Take it back', `data-id="${r.id}" data-kind="refundcoll"`) : ''}
        </div>`).join('')}
    </section>` : '';

  return `
      ${stopped}
      <ol class="v2-steps">
        ${step(1, 'Claim your rewards', toClaim.length ? 'now' : 'done', claimBody)}
        ${step(2, 'Unstake', toUnstake.length ? 'now' : 'done', unstakeBody)}
        ${step(3, 'Collect what finished unstaking', ready.length ? 'now' : waiting.length ? 'wait' : 'done', refundBody)}
      </ol>
      ${retiredBody}
      ${collectionsBody}
      ${st.error ? `<p class="v2-error">${esc(st.error)}</p>` : ''}`;
}

const GROUPS: { group: HoldingGroup; title: string; blurb: string }[] = [
  { group: 'nft-farm', title: 'NFT farms', blurb: 'waxdaofarmer holds these NFTs until you unstake them.' },
  { group: 'token-pool', title: 'Token pools', blurb: 'Tokens staked in waxdaofarmer pools.' },
  { group: 'nft-farm-v2', title: 'NFT farms v2', blurb: 'farms.waxdao never took the NFTs; only the rewards wait there.' },
  { group: 'token-farm', title: 'Token farms', blurb: 'Tokens staked in tf.waxdao farms.' },
  { group: 'dao', title: 'DAO staking', blurb: 'Tokens staked to vote in a DAO on dao.waxdao.' },
  { group: 'lock', title: 'Token locks', blurb: 'Tokens locked for you on waxdaolocker.' },
  { group: 'backer', title: 'Backed tokens', blurb: 'Tokens released by token-backed NFTs, waiting on waxdaobacker.' },
  { group: 'market', title: 'WaxDAO market', blurb: 'What a creator left on waxdaomarket: RAM, tokens, premint pools.' },
];

/**
 * One of a WaxDAO card's two button slots: a fixed size at a fixed place,
 * so a list of farms reads as one column of Claim and one of Unstake. An
 * action that does not apply leaves its slot empty rather than letting the
 * other one slide over. The amounts are in the card's text, not on the
 * button, which is what keeps every button the same width.
 */
function wdSlot(key: string, label: string, build: BuiltAction[] | undefined): string {
  if (!build) return '<span class="v2-wd-slot" aria-hidden="true"></span>';
  wdActions.set(key, build);
  if (!canSign()) return `<span class="v2-wd-slot v2-wd-btn v2-wd-would" title="Only ${esc(viewing)} can sign this">${esc(label)}</span>`;
  const busy = doing?.key === key;
  return `<button class="v2-wd-slot v2-wd-btn lab-primary" data-stake-act="${esc(key)}" data-kind="waxdao" ${doing ? 'disabled' : ''}>
    ${busy ? (doing!.phase === 'checking' ? 'Checking…' : 'Signing…') : esc(label)}</button>`;
}

/** How the last of these buttons ended, under the card that holds them. */
function wdOutcome(keys: string[]): string {
  const out = outcome && keys.includes(outcome.key) ? outcome : undefined;
  if (!out || out.kind === 'done') return '';
  return out.kind === 'refused'
    ? `<p class="lab-warn v2-wd-outcome">The chain would refuse it, so your wallet was not opened: ${esc(out.text)}</p>`
    : `<p class="lab-warn v2-wd-outcome">Not signed: ${esc(out.text)}</p>`;
}

/** The short word for the second slot. */
const SECOND: [RegExp, string][] = [[/^Unstake/, 'Unstake'], [/^Withdraw/, 'Withdraw'], [/^Take back/, 'Take back']];

/** A card: what is there on the left, the two slots on the right. */
function wdCard(keyBase: string, text: string, claim: BuiltAction[] | undefined, second: { label: string; build: BuiltAction[] } | undefined, extra = 'v2-stake-card'): string {
  const keys = [`${keyBase}:claim`, `${keyBase}:second`];
  return `
    <div class="${extra} v2-wd-card">
      <div class="v2-wd-text">${text}</div>
      <div class="v2-wd-slots">
        ${wdSlot(keys[0], 'Claim', claim)}
        ${wdSlot(keys[1], second?.label ?? '', second?.build)}
      </div>
      ${wdOutcome(keys)}
    </div>`;
}

/** Everything WaxDAO holds for this wallet, by contract, each with its buttons. */
function renderWaxdao(actor: string): string {
  if (!wd.loaded || wd.actor !== actor) {
    return `<p class="lab-hint">Reading what WaxDAO's contracts hold for <code>${esc(actor)}</code>.</p>
      ${wd.error ? `<p class="v2-error">${esc(wd.error)}</p>` : ''}`;
  }
  wdActions.clear();
  // A withdrawal empties its card, so the confirmation is said up here.
  const signed = outcome?.kind === 'done' && outcome.key.startsWith('waxdao:')
    ? `<p class="lab-ok">Signed. <a target="_blank" rel="noreferrer" href="https://waxblock.io/transaction/${esc(outcome.trx ?? '')}">view it on waxblock</a></p>` : '';
  if (!wd.items.length) return signed + '<p class="lab-hint">Nothing on WaxDAO: no farm, pool, DAO, lock or balance holds anything for this wallet.</p>';
  return signed + GROUPS.map(({ group, title, blurb }) => {
    // Most NFTs first: that is where the most is waiting.
    const items = wd.items.filter((h) => h.group === group)
      .sort((a, b) => (parseInt(b.title, 10) || 0) - (parseInt(a.title, 10) || 0));
    if (!items.length) return '';
    // v1 farms: everything in two signatures when there are many.
    let shortcuts = '';
    if (group === 'nft-farm') {
      const rewards = items.filter((h) => h.detail);
      const unstakable = items.filter((h) => h.actions.some((a) => a.label.startsWith('Unstake')));
      const nfts = unstakable.reduce((n, h) => n + (parseInt(h.title, 10) || 0), 0);
      // claimall pays every farm the wallet is in, so it opens every reward token they use.
      const claimAll = rewards.length > 1 && !items.some((h) => h.broken);
      const many = unstakable.length > 1;
      if (claimAll || many) {
        const lines = [
          claimAll ? `Claim: every farm's rewards, ${rewards.length} farms, in one signature.` : '',
          many ? (unstakable.length > FARMS_PER_TRANSACTION
            ? `Unstake: the first ${FARMS_PER_TRANSACTION} of ${unstakable.length} farms in one signature, then the next ones.`
            : `Unstake: all ${unstakable.length} farms (${nfts} NFTs) in one signature.`) : '',
        ].filter(Boolean);
        shortcuts = wdCard('waxdao:all', `<strong>All farms at once</strong>${lines.map((l) => `<span>${esc(l)}</span>`).join('')}`,
          claimAll ? claimAllFarms(actor, items) : undefined,
          many ? { label: 'Unstake all', build: unstakeManyFarms(actor, unstakable) } : undefined,
          'v2-stake-card v2-stake-shortcuts');
      }
    }
    return `
      <div class="v2-stake-section">
        <h3>${esc(title)} <span>${items.length}</span></h3>
        <p class="lab-hint">${esc(blurb)}</p>
        ${shortcuts}
        ${items.map((h) => {
          const claim = h.actions.find((a) => /^Claim/.test(a.label));
          const other = h.actions.find((a) => !/^Claim/.test(a.label));
          const word = other ? (SECOND.find(([re]) => re.test(other.label))?.[1] ?? other.label) : '';
          return wdCard(`waxdao:${h.key}`, `
            <strong>${esc(h.title)}</strong>
            ${h.detail ? `<span>${esc(h.detail)}</span>` : ''}
            ${h.note ? `<span class="lab-hint">${esc(h.note)}</span>` : ''}`,
            claim?.build, other ? { label: word, build: other.build } : undefined);
        }).join('')}
      </div>`;
  }).join('');
}

/** The transaction for one button, built the way the classic page builds it. */
function actionsFor(kind: string, el: HTMLElement, actor: string): BuiltAction[] | string {
  if (kind === 'waxdao') {
    // Built for wd.actor; another wallet must not sign them.
    if (wd.actor !== actor) return 'The wallet changed since this was read.';
    return wdActions.get(el.dataset.stakeAct ?? '') ?? 'That one is gone.';
  }
  const p = st.positions.find((x) => x.scope === el.dataset.scope);
  if (kind === 'claim' && p) return buildClaimFor(actor, p);
  if (kind === 'unstake' && p) {
    const contract = tokenContractFor(p, st.pools);
    return contract ? buildUnstakeFor(actor, p, contract) : `No contract on chain issues ${p.stakedSymbol}.`;
  }
  const id = Number(el.dataset.id);
  if (kind === 'refund') {
    const r = st.refunds.find((x) => x.id === id);
    return r ? buildRefundFor(actor, r) : 'That refund is gone.';
  }
  if (kind === 'unstakecoll') {
    const c = st.collections.find((x) => x.collection === el.dataset.collection);
    if (!c) return 'That collection stake is gone.';
    if (c.author !== actor) return `${c.collection} was staked by ${c.author}, not by this wallet.`;
    return buildCollectionUnstakeFor(c);
  }
  if (kind === 'refundcoll') {
    const r = st.collectionRefunds.find((x) => x.id === id);
    return r ? buildCollectionRefundFor(actor, r) : 'That refund is gone.';
  }
  return 'Nothing to sign.';
}

export function attachStakeHandlers(root: HTMLElement, repaint: () => void, go?: (hash: string) => void): void {
  root.querySelector<HTMLFormElement>('[data-stake-lookup]')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const v = String(new FormData(ev.target as HTMLFormElement).get('account') ?? '').trim().toLowerCase();
    if (/^[a-z1-5.]{1,12}$/.test(v)) go?.(`#/stake/${v}`);
  });
  root.querySelectorAll<HTMLElement>('[data-stake-act]').forEach((el) => el.addEventListener('click', async () => {
    const session = getCurrentSession();
    if (!session || doing) return;
    const actor = String(session.actor);
    const key = el.dataset.stakeAct!;
    // What is on screen belongs to st.actor; signing one account's amounts
    // from another wallet is what this stops.
    if (st.actor !== actor) { st.loaded = false; repaint(); return; }
    const built = actionsFor(el.dataset.kind ?? '', el, actor);
    if (typeof built === 'string') { outcome = { key, kind: 'failed', text: built }; repaint(); return; }
    doing = { key, phase: 'checking' };
    outcome = undefined;
    repaint();
    try {
      const sim = await simulateActions(built);
      if (sim.kind === 'refused') { outcome = { key, kind: 'refused', text: sim.reason }; return; }
      doing = { key, phase: 'signing' };
      repaint();
      const result = await session.transact({ actions: built });
      const trx = (result.response as { transaction_id?: string } | undefined)?.transaction_id
        ?? String(result.resolved?.transaction.id ?? '');
      outcome = { key, kind: 'done', text: '', trx };
      // The position just changed, so what is on screen is already stale.
      if (el.dataset.kind === 'waxdao') wd.loaded = false;
      else st.loaded = false;
    } catch (e) {
      outcome = { key, kind: 'failed', text: e instanceof Error ? e.message : String(e) };
    } finally {
      doing = undefined;
      repaint();
    }
  }));
}
