/**
 * What NeftyBlocks' contracts still hold for one account, besides staking.
 * ─────────────────────────────────────────────────────────────
 * A player pays a drop, a blend or an upgrade by sending tokens first, and
 * opens a pack by sending it first. When the second half never ran, what
 * was sent stays in the contract under the player's name, and nothing on
 * any page says so. Scanned whole on 2026-10-24:
 *
 *   neftyblocksd  balances     2,468 accounts   ~24,566 WAX, 2,672 NEFTY, ...  withdraw
 *   blend.nefty   extbalances     34 accounts   42,964 RUST, 78,301 AGAR, ...  withdrawubal
 *   up.nefty      extbalances     67 accounts   547,032 AGAR                   withdrawubal
 *   atomicpacksx  unboxpacks   3,817 packs      opened, cards never minted     claimunboxed
 *   neftyblocksp  claimassets  1,330 packs      opened, cards never minted     claim
 *
 * Each withdrawal was run through compute_transaction as real holders, for
 * every token above: accepted. Packs go through ui/runFinish, which asks
 * the chain about each one and says why when it cannot be finished.
 *
 * Shown, with nothing to sign:
 *   - blend.nefty `inventory`: 190 NFTs from 11 accounts, sent for a blend
 *     that never ran. The contract has no action that sends NFTs back.
 *   - draws the oracle never answered: 20 jobs. Asking the oracle again is
 *     `retryrand`, which no player can sign ("Missing required authority"):
 *       blend.nefty  `orngjobs2`  retryrand { claim_id: <job_id> } under
 *                    blend.nefty@claimer (ac.nefty, ja.nefty or its key):
 *                    accepted when simulated under that permission
 *       blend.nefty  `orngjobs`   the older table, which retryrand no longer
 *                    reads: refused even under that permission ("No job
 *                    entry with the specified claim id exists")
 *       neftyblocksp `orngjobs`   retryrand under neftyblocksp@active
 *                    (admins.nefty): it ran out of the simulator's CPU
 *                    there, which is not a refusal
 *     NeftyBlocks' site is offline, but those accounts still hold the
 *     permission, so the cards say what they would sign.
 */
import type { BuiltAction } from '../chain/action';
import { atomicFetch, getTableRows } from '../chain/rpc';
import {
  PENDING_LIMIT, readPendingFinishes, buildFinishActions, type BlockedBy, type FinishKind, type PendingFinish,
} from '../ui/runFinish';

/** Pack finishes signed together by "Finish all" (ui/runFinish). */
export { FINISHES_PER_TRANSACTION } from '../ui/runFinish';

export type LeftoverGroup = 'deposit' | 'finish' | 'draw' | 'held';

/**
 * What a page explains once, above the cards, for every card that points
 * to it: why nothing can be signed, who could still fix it, and how.
 */
export type NoteId = 'draw-blend' | 'draw-old' | 'draw-pack' | 'pack-authorization' | 'pack-ram' | 'pack-backing' | 'pack-refused' | 'held' | 'more';

export const LEFTOVER_NOTES: Record<NoteId, { title: string; body: string }> = {
  'draw-blend': {
    title: 'Blends waiting for their draw: NeftyBlocks can relaunch them',
    body: 'The WAX oracle never sent the random number these blends wait for. A draw a few seconds old is normal; one still here a minute later was never answered. What was paid for it is spent. To relaunch it, blend.nefty signs retryrand { claim_id: the number on the card } with its claimer permission, held by NeftyBlocks\' accounts ac.nefty and ja.nefty. No player can sign that, and neither can Crucible; asked of the chain under that permission, it is accepted. The oracle then answers within seconds and the result is minted to you with nothing to sign, or, if it is staged instead, appears under "Opened, never minted" for one signature of yours. NeftyBlocks\' site is offline, but its contracts still run and those accounts still hold the permission: if NeftyBlocks comes back online, or you reach them, the number on each card is all they need.',
  },
  'draw-old': {
    title: 'Blends in the older job table: only NeftyBlocks, by changing the contract',
    body: 'These also wait for a random number the oracle never sent, but in blend.nefty\'s older job table, which retryrand no longer reads: even NeftyBlocks\' own permission is refused ("No job entry with the specified claim id exists"). What was paid for them is spent. NeftyBlocks could still finish them by changing the contract\'s code; nobody else can. If they come back online, the number on each card is what they would need.',
  },
  'draw-pack': {
    title: 'Packs waiting for their draw: NeftyBlocks can relaunch them',
    body: 'The WAX oracle never sent the random number these packs wait for. A draw a few seconds old is normal; one still here a minute later was never answered. To relaunch it, neftyblocksp signs retryrand { claim_id: the number on the card } with its active permission, held by NeftyBlocks\' admins.nefty. No player can sign that, and neither can Crucible. The oracle then answers within seconds, and the pack\'s NFTs appear under "Opened, never minted" for one signature of yours. NeftyBlocks\' site is offline, but its contracts still run and that account still holds the permission: if NeftyBlocks comes back online, or you reach them, the number on each card is all they need.',
  },
  'pack-authorization': {
    title: 'Packs whose collection stopped the pack contract',
    body: 'The collection removed the pack contract from the accounts allowed to mint its NFTs, so the chain refuses to mint these cards ("Missing authorization for this collection"). Only the collection\'s author can fix it, by adding the contract back to the collection\'s authorized accounts on AtomicHub. The pack then finishes here with one signature.',
  },
  'pack-ram': {
    title: 'Packs whose collection ran out of RAM',
    body: 'The pack contract mints the cards from RAM the collection deposited with it, and there is too little left ("The collection does not have enough RAM to mint the assets"). Topping it up is the collection author\'s to do. The pack then finishes here with one signature.',
  },
  'pack-backing': {
    title: 'Packs of token-backed NFTs',
    body: 'These packs\' cards are NFTs backed with tokens, which AtomicAssets no longer mints ("Native backing has been deprecated on the AtomicAssets Contract"). Nothing a player or the collection signs can finish them as they stand: only a change to the pack contract\'s code could.',
  },
  'pack-refused': {
    title: 'Packs the chain refuses to finish',
    body: 'The chain refuses to mint these for the reason shown on each card. Crucible offers no button for a transaction it knows would be refused.',
  },
  held: {
    title: 'NFTs blend.nefty kept',
    body: 'Sent to blend.nefty for a blend that never ran. blend.nefty still owns them, and the contract has no action that sends NFTs back, so Crucible offers none. Only NeftyBlocks could return them, by changing the contract\'s code.',
  },
  more: {
    title: 'More than shown',
    body: `Crucible reads ${PENDING_LIMIT} unfinished packs per contract at a time. Finishing these brings the next ones up.`,
  },
};

export interface NeftyLeftover {
  key: string;
  group: LeftoverGroup;
  contract: string;
  /** One line, e.g. "12.50000000 WAX deposited for a drop". */
  title: string;
  detail?: string;
  /** The notes this card points to (LEFTOVER_NOTES), explained once above the cards. */
  notes?: NoteId[];
  /** The button, its own transaction; none when nothing can be signed. */
  action?: { label: string; build: BuiltAction[] };
}

const BLOCKED_NOTE: Record<BlockedBy, NoteId> = {
  authorization: 'pack-authorization', ram: 'pack-ram', backing: 'pack-backing', refused: 'pack-refused',
};

const auth = (actor: string) => [{ actor, permission: 'active' }];
const act = (account: string, name: string, actor: string, data: Record<string, unknown>): BuiltAction =>
  ({ account, name, authorization: auth(actor), data });
const positive = (q: string) => parseFloat(q) > 0;

/** The row keyed by this account, or none. */
async function own<T>(code: string, table: string, actor: string): Promise<T | undefined> {
  const rows = await getTableRows<T & { owner: string }>({ code, scope: code, table, lower_bound: actor, upper_bound: actor, limit: 1 });
  return rows.find((r) => String(r.owner) === actor);
}

const PAID_FOR: Record<string, string> = { neftyblocksd: 'a drop', 'blend.nefty': 'a blend', 'up.nefty': 'an upgrade' };

/** Tokens sent to pay for something that did not use them. */
async function deposits(actor: string): Promise<NeftyLeftover[]> {
  const out: NeftyLeftover[] = [];
  const drop = await own<{ quantities: string[] }>('neftyblocksd', 'balances', actor);
  for (const q of (drop?.quantities ?? []).filter(positive)) {
    out.push({
      key: `deposit:neftyblocksd:${q.split(' ')[1]}`, group: 'deposit', contract: 'neftyblocksd',
      title: `${q} deposited for ${PAID_FOR.neftyblocksd}`,
      action: { label: 'Withdraw', build: [act('neftyblocksd', 'withdraw', actor, { owner: actor, token_to_withdraw: q })] },
    });
  }
  for (const code of ['blend.nefty', 'up.nefty']) {
    const row = await own<{ quantities: { quantity: string; contract: string }[] }>(code, 'extbalances', actor);
    for (const q of (row?.quantities ?? []).filter((x) => positive(x.quantity))) {
      out.push({
        key: `deposit:${code}:${q.contract}:${q.quantity.split(' ')[1]}`, group: 'deposit', contract: code,
        title: `${q.quantity} deposited for ${PAID_FOR[code]}`,
        detail: `token contract ${q.contract}`,
        action: { label: 'Withdraw', build: [act(code, 'withdrawubal', actor, { owner: actor, amount: q })] },
      });
    }
  }
  return out;
}

const finishNoun = (p: PendingFinish) => (p.kind === 'blend' ? `Result of blend #${p.recipe}` : `Pack #${p.id}`);

/** Packs opened and blend results drawn, never minted (ui/runFinish). */
async function finishes(actor: string): Promise<NeftyLeftover[]> {
  const found = await readPendingFinishes(actor);
  // A full read means there may be more behind it: say so on the last one of that kind.
  const full = new Set((['blend', 'pack', 'neftypack'] as FinishKind[]).filter((k) => found.filter((p) => p.kind === k).length >= PENDING_LIMIT));
  const lastOf = new Map(found.map((p) => [p.kind, p.id]));
  return found.map((p) => {
    const n = p.drawn.length;
    return {
      key: `finish:${p.kind}:${p.id}`, group: 'finish',
      contract: p.kind === 'blend' ? 'blend.nefty' : p.kind === 'pack' ? 'atomicpacksx' : 'neftyblocksp',
      title: `${finishNoun(p)}${p.collection ? ` from ${p.collection}` : ''}`,
      detail: [
        p.ready ? `${n} NFT${n === 1 ? '' : 's'} drawn, never minted` : 'Sent to be opened; the oracle has not drawn it yet.',
        // The one refusal no note can word: the contract's own.
        p.blockedBy === 'refused' ? p.blocked : '',
      ].filter(Boolean).join(' · '),
      notes: [
        ...(p.blockedBy ? [BLOCKED_NOTE[p.blockedBy]] : []),
        ...(full.has(p.kind) && lastOf.get(p.kind) === p.id ? ['more' as const] : []),
      ],
      action: p.ready && !p.blocked ? { label: 'Finish', build: buildFinishActions(p, actor) } : undefined,
    };
  });
}

/** Draws still waiting for the oracle, for this account. Small tables, read whole. */
async function draws(actor: string): Promise<NeftyLeftover[]> {
  const read = <T>(code: string, table: string) =>
    getTableRows<T>({ code, scope: code, table, limit: 500 }).catch(() => [] as T[]);
  const [b1, b2, p1] = await Promise.all([
    read<{ claim_id: string | number; collection_name: string; recipe_id: string | number; recipient: string }>('blend.nefty', 'orngjobs'),
    read<{ job_id: string | number; collection_name: string; recipe_id: string | number; claims: { claim_id: string | number; recipient: string }[] }>('blend.nefty', 'orngjobs2'),
    read<{ claim_id: string | number; collection_name: string; recipe_id: string | number; recipient: string }>('neftyblocksp', 'orngjobs'),
  ]);
  const one = (contract: string, id: string | number, what: string, collection: string, note: NoteId): NeftyLeftover => ({
    key: `draw:${contract}:${id}`, group: 'draw', contract, title: `${what} on ${collection}, never drawn`,
    detail: `waiting as #${id} on ${contract}`, notes: [note],
  });
  return [
    ...b2.filter((j) => j.claims.some((c) => c.recipient === actor))
      .map((j) => one('blend.nefty', j.job_id, `Blend #${j.recipe_id}`, j.collection_name, 'draw-blend')),
    ...b1.filter((j) => j.recipient === actor)
      .map((j) => one('blend.nefty', j.claim_id, `Blend #${j.recipe_id}`, j.collection_name, 'draw-old')),
    ...p1.filter((j) => j.recipient === actor)
      .map((j) => one('neftyblocksp', j.claim_id, 'A pack', j.collection_name, 'draw-pack')),
  ];
}

/** NFTs blend.nefty still holds from a blend that never ran: shown, not offered. */
async function held(actor: string): Promise<NeftyLeftover[]> {
  const row = await own<{ assets: (string | number)[] }>('blend.nefty', 'inventory', actor);
  const ids = (row?.assets ?? []).map(String);
  if (!ids.length) return [];
  // The row can outlive the NFTs: count only what the contract still owns.
  let still = ids.length;
  try {
    const pages = [];
    for (let i = 0; i < ids.length; i += 100) pages.push(ids.slice(i, i + 100));
    const found = await Promise.all(pages.map((page) => atomicFetch<{ asset_id: string; owner: string | null }[]>(
      `/atomicassets/v1/assets?ids=${page.join(',')}&limit=100`)));
    still = found.flat().filter((a) => a.owner === 'blend.nefty').length;
  } catch { /* unreadable: say what the row lists */ }
  if (!still) return [];
  return [{
    key: 'held:blend.nefty', group: 'held', contract: 'blend.nefty',
    title: `${still} NFT${still === 1 ? '' : 's'} sent to blend.nefty for a blend that never ran`,
    notes: ['held'],
  }];
}

/** Everything above, for one account. A read that fails leaves its part out rather than the whole. */
export async function readNeftyLeftovers(actor: string): Promise<NeftyLeftover[]> {
  const parts = await Promise.allSettled([deposits(actor), finishes(actor), draws(actor), held(actor)]);
  const failed = parts.filter((p) => p.status === 'rejected');
  if (failed.length === parts.length) throw (failed[0] as PromiseRejectedResult).reason;
  return parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : []));
}
