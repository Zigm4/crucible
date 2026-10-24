/**
 * WaxDAO's drops, for players: claim one, buy one, or open a pack.
 * ─────────────────────────────────────────────────────────────
 * waxdaomarket's `drops` table holds two different things under one name,
 * told apart by `drop_type`:
 *
 *   standard      a sale or a giveaway: the contract mints `template_id`
 *                 to the player.
 *                   free  claimdrop { drop_ID, user, quantity_to_mint, unique_id }
 *                   paid  assertdrop { drop_ID, user, quantity_to_assert }, then
 *                         <contract>::transfer of price x quantity to waxdaomarket,
 *                         memo "|purchase_drop|<drop>|<unique>|" (trace 47cc05fe...,
 *                         25 KASH for #2107: 98% to the drop's receiver, 2% to
 *                         waxdaosaving, the RAM bought by the contract)
 *   premint.pack  a pack opening: the player sends an NFT of `template_id`
 *                 (the pack) to waxdaomarket, memo "|unbox|<drop>|<unique>|";
 *                 the contract burns it and sends NFTs drawn from the premint
 *                 pools named in `other`, in the same transaction (trace
 *                 d43e6470..., drop #558, October 2026)
 *
 * Settled through compute_transaction on 2026-10-24: a free drop sent the
 * paid way is refused ("Invalid price. Is this is a free drop, use the
 * claimdrop action"), a pack sent claimdrop ("Invalid drop type. If
 * unboxing a pack, use the unbox action"), and a standard drop of a
 * collection without RAM ("This collection needs to deposit more RAM").
 *
 * On a drop with no cap `total_available` is 0 and `total_left` counts down
 * from 4,294,967,295. Of the 867 drops on 2026-10-24, 310 were open with
 * stock (224 free), 223 of them packs, across 48 collections.
 */
import type { BuiltAction } from '../chain/action';
import { getTableRows, retrying } from '../chain/rpc';

export type WaxdaoDropStatus = 'active' | 'upcoming' | 'ended' | 'sold_out';

export interface DiscoveredWaxdaoDrop {
  drop_id: string;
  collection: string;
  kind: 'standard' | 'pack';
  /** The first line of the creator's description, or "Drop #id". */
  name: string;
  description: string;
  logo: string;
  /** "25.00000000 KASH", or '' for a free drop. */
  price: string;
  /** The token's contract, '' for a free drop. */
  price_contract: string;
  /** What a standard drop mints, or the pack a pack drop opens. */
  template_id: number;
  /** Pack drops: the premint pools the NFTs are drawn from. */
  pools: string[];
  /** 0 when there is no cap. */
  total_available: number;
  /** What is left; meaningless when there is no cap. */
  total_left: number;
  limit_per_user: number;
  cooldown: number;
  whitelist_type: string;
  allowed_users: string[];
  farmname: string;
  minimum_to_stake: number;
  start_time: number;
  end_time: number;
  status: WaxdaoDropStatus;
}

interface RawDrop {
  ID: number | string; collection: string; price: string; contract: string; template_id: number;
  total_left: number | string; total_available: number | string; limit_per_user: number | string; cooldown: number | string;
  whitelist_type: string; allowed_users: string[]; farmname: string; minimum_to_stake: number | string;
  start_time: number | string; end_time: number | string; drop_description: string; drop_logo: string;
  drop_type: string; other: string[];
}

/** A name out of the creator's description: its first sentence, short enough for a list. */
function titleOf(description: string): string {
  const line = description.split('\n')[0].trim();
  if (line.length <= 60) return line;
  const sentence = /^(.{8,60}?[.!?])\s/.exec(line)?.[1];
  if (sentence) return sentence;
  return `${line.slice(0, 57).replace(/\s+\S*$/, '')}...`;
}

const free = (r: RawDrop) => r.contract === 'free' || !/[1-9]/.test(String(r.price).split(' ')[0]);

function toDiscovered(r: RawDrop): DiscoveredWaxdaoDrop {
  const now = Date.now() / 1000;
  const start = Number(r.start_time) || 0;
  const end = Number(r.end_time) || 0;
  const available = Number(r.total_available) || 0;
  const left = Number(r.total_left) || 0;
  const description = String(r.drop_description ?? '').trim();
  const first = titleOf(description);
  return {
    drop_id: String(r.ID),
    collection: String(r.collection),
    kind: r.drop_type === 'premint.pack' ? 'pack' : 'standard',
    name: first || `Drop #${r.ID}`,
    description,
    logo: String(r.drop_logo ?? ''),
    price: free(r) ? '' : String(r.price),
    price_contract: free(r) ? '' : String(r.contract),
    template_id: Number(r.template_id) || 0,
    pools: r.drop_type === 'premint.pack' ? (r.other ?? []).filter((x) => /^\d+$/.test(String(x))).map(String) : [],
    total_available: available,
    total_left: left,
    limit_per_user: Number(r.limit_per_user) || 0,
    cooldown: Number(r.cooldown) || 0,
    whitelist_type: String(r.whitelist_type ?? 'none'),
    allowed_users: (r.allowed_users ?? []).map(String).filter(Boolean),
    farmname: String(r.farmname ?? ''),
    minimum_to_stake: Number(r.minimum_to_stake) || 0,
    start_time: start,
    end_time: end,
    status: start > now ? 'upcoming' : end > 0 && end < now ? 'ended' : left <= 0 ? 'sold_out' : 'active',
  };
}

let table: { at: number; rows: RawDrop[] } | undefined;
/** The whole table, read at most once a minute: 867 rows, a page. */
async function readDrops(): Promise<RawDrop[]> {
  if (table && Date.now() - table.at < 60_000) return table.rows;
  const rows: RawDrop[] = [];
  let lower = '';
  for (let page = 0; page < 20; page++) {
    const r = await retrying(() => getTableRows<RawDrop>({ code: 'waxdaomarket', scope: 'waxdaomarket', table: 'drops', limit: 1000, lower_bound: lower }));
    rows.push(...r);
    if (r.length < 1000) break;
    lower = String(Number(r[r.length - 1].ID) + 1);
  }
  table = { at: Date.now(), rows };
  return rows;
}

/** Every WaxDAO drop, whichever collection. */
export async function listAllWaxdaoDrops(): Promise<DiscoveredWaxdaoDrop[]> {
  return (await readDrops()).map(toDiscovered);
}

/** A collection's WaxDAO drops, standard and pack alike. */
export async function listWaxdaoDrops(collection: string): Promise<DiscoveredWaxdaoDrop[]> {
  const c = collection.trim().toLowerCase();
  return (await readDrops()).filter((r) => String(r.collection) === c).map(toDiscovered);
}

export async function loadWaxdaoDropById(id: string): Promise<DiscoveredWaxdaoDrop | undefined> {
  const rows = await retrying(() => getTableRows<RawDrop>({ code: 'waxdaomarket', scope: 'waxdaomarket', table: 'drops', lower_bound: id, upper_bound: id, limit: 1 }));
  return rows.find((r) => String(r.ID) === id) ? toDiscovered(rows[0]) : undefined;
}

/**
 * The RAM a collection keeps on waxdaomarket, in WAX, that standard drops
 * mint from. It can be negative: packs release RAM as they burn, and the
 * contract lets the balance go below zero. undefined when unreadable.
 */
export async function readWaxdaoRam(collection: string): Promise<number | undefined> {
  const rows = await getTableRows<{ collection: string; balance: string }>({
    code: 'waxdaomarket', scope: 'waxdaomarket', table: 'rambalances',
    index_position: 'secondary', key_type: 'name', lower_bound: collection, upper_bound: collection, limit: 10,
  }).catch(() => undefined);
  if (!rows) return undefined;
  return rows.filter((r) => r.collection === collection).reduce((n, r) => n + (parseFloat(r.balance) || 0), 0);
}

/** How many NFTs a pack drop's pools still hold. undefined when unreadable. */
export async function readPackPools(pools: string[]): Promise<{ id: string; name: string; left: number }[] | undefined> {
  try {
    return await Promise.all(pools.map(async (id) => {
      const [p] = await retrying(() => getTableRows<{ ID: number | string; display_name: string; amount_of_assets: number | string }>({
        code: 'waxdaomarket', scope: 'waxdaomarket', table: 'premintpools', lower_bound: id, upper_bound: id, limit: 1,
      }));
      return { id, name: String(p?.display_name ?? `pool ${id}`), left: Number(p?.amount_of_assets ?? 0) };
    }));
  } catch { return undefined; }
}

/** What this account already took from a limited drop, and when its window resets. */
export async function readWaxdaoDropUse(dropId: string, actor: string): Promise<{ quantity: number; cooldown_reset: number } | undefined> {
  const rows = await getTableRows<{ user: string; drop: number | string; quantity: number | string; cooldown_reset: number | string }>({
    code: 'waxdaomarket', scope: 'waxdaomarket', table: 'purchases',
    index_position: 'secondary', key_type: 'name', lower_bound: actor, upper_bound: actor, limit: 500,
  });
  const r = rows.find((x) => x.user === actor && String(x.drop) === dropId);
  return r ? { quantity: Number(r.quantity) || 0, cooldown_reset: Number(r.cooldown_reset) || 0 } : undefined;
}

/** A fresh id for the memo: the contract only needs it to tell two orders apart. */
export const dropUniqueId = () => String(1 + Math.floor(Math.random() * 2_000_000_000));

/** price x quantity, in the token's own decimals. "25.00000000 KASH" x 2 -> "50.00000000 KASH". */
export function timesQuantity(price: string, quantity: number): string {
  const [amount, symbol] = price.split(' ');
  const decimals = (amount.split('.')[1] ?? '').length;
  const units = BigInt(amount.replace('.', '')) * BigInt(quantity);
  const s = units.toString().padStart(decimals + 1, '0');
  return `${decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals)}` : s} ${symbol}`;
}

const auth = (actor: string) => [{ actor, permission: 'active' }];

/** Claiming or buying a standard drop. */
export function buildWaxdaoDropClaim(args: { claimer: string; drop: DiscoveredWaxdaoDrop; quantity?: number; unique_id?: string }): BuiltAction[] {
  const { claimer, drop } = args;
  const quantity = args.quantity ?? 1;
  const unique = args.unique_id ?? dropUniqueId();
  if (drop.kind !== 'standard') throw new Error('A pack is opened, not claimed.');
  if (!drop.price) {
    return [{ account: 'waxdaomarket', name: 'claimdrop', authorization: auth(claimer),
      data: { drop_ID: drop.drop_id, user: claimer, quantity_to_mint: quantity, unique_id: unique } }];
  }
  return [
    { account: 'waxdaomarket', name: 'assertdrop', authorization: auth(claimer),
      data: { drop_ID: drop.drop_id, user: claimer, quantity_to_assert: quantity } },
    { account: drop.price_contract, name: 'transfer', authorization: auth(claimer),
      data: { from: claimer, to: 'waxdaomarket', quantity: timesQuantity(drop.price, quantity), memo: `|purchase_drop|${drop.drop_id}|${unique}|` } },
  ];
}

/** Opening a pack: the pack NFT goes to waxdaomarket, which burns it and sends what it holds. */
export function buildWaxdaoUnbox(args: { claimer: string; drop_id: string; pack_asset_id: string; unique_id?: string }): BuiltAction[] {
  return [{ account: 'atomicassets', name: 'transfer', authorization: auth(args.claimer),
    data: { from: args.claimer, to: 'waxdaomarket', asset_ids: [args.pack_asset_id], memo: `|unbox|${args.drop_id}|${args.unique_id ?? dropUniqueId()}|` } }];
}
