/**
 * Can this account run this recipe now, and if not, why not.
 * ─────────────────────────────────────────────────────────────
 * The classic panels answer this per contract, in their own words: a drop
 * row says "limit reached" or "not whitelisted" and greys out, a blend says
 * "whitelist · denied". The guided runner listed recipes with none of it, so
 * a drop already claimed to its limit looked exactly like a free one, and the
 * check step said "ready to sign" for recipes the chain would refuse.
 *
 * This module turns every recipe the runner lists, from any of the seven
 * contracts, into the same thing: a short list of checks, each one a plain
 * sentence with a tone.
 *
 *   ok       satisfied                          "You are on the whitelist"
 *   info     a fact, neither good nor bad        "12 of 100 left"
 *   warn     not runnable yet, but fixable       "Short of 2 x template #12"
 *   block    not runnable, nothing you can do    "You reached the limit"
 *   pending  unknown until a wallet or a read    "Connect a wallet to check"
 *
 * A recipe with a blocking check is closed: the list shows it, with the
 * reason, but does not open it. Fixable ones stay open so the check step can
 * show exactly what is missing. That is the classic panels' rule.
 *
 * The rules are the classic ones and the data comes from the same readers;
 * only the per-account blend limit is new, because nothing read it before.
 * Everything here is pure except loadCheckContext, which does the reads one
 * collection needs, once, and keeps them in a context the checks consult.
 */
import type { AtomicAsset } from '../atomic/assets';
import { isContractAuthorized } from '../atomic/collections';
import { readBlenderizerRam, type DiscoveredBlenderizerBlend } from '../blenderizer/blends';
import { isDeterministic, type BlendRow } from '../nefty/blend';
import {
  blendUsesLeft, readBlendLimits, readBlendUse, type BlendLimit, type BlendUse,
} from '../nefty/blendLimits';
import { blendStatusOf, type DiscoveredBlend } from '../nefty/discover';
import { proofShortfall, type DiscoveredDrop, type ProofFilter } from '../nefty/drops';
import type { MarketRef } from '../atomic/atomichub';
import type { PackDesign } from '../nefty/packs';
import { proofFor, readSecurityGate, type SecurityGate } from '../nefty/security';
import type { DiscoveredUpgrade } from '../nefty/upgrades';
import {
  readFarmStakes, readNonCustodialFarms, readWaxdaoUse, waxdaoUsesLeft,
  type DiscoveredWaxdaoBlend, type WaxdaoUse,
} from '../waxdao/blends';
import { checkTokenCost, type TokenCost } from './bridge';
import {
  describeRecipe, requirementsOf,
  type RecipeChoice, type RecipeSource, type Requirement,
} from './guidedRun';

export type CheckTone = 'ok' | 'info' | 'warn' | 'block' | 'pending';

export interface RecipeCheck {
  tone: CheckTone;
  text: string;
  /**
   * Set on the "what you hold" line, which the check step already shows slot
   * by slot, so its sign button does not list the same shortfall twice.
   */
  about?: 'nfts';
  /** Where to find what is missing: one AtomicHub reference per filter short. */
  market?: MarketRef[];
}

export interface RecipeVerdict {
  /** The worst tone among the checks, which is the row's colour. */
  tone: 'ok' | 'warn' | 'block' | 'pending';
  /** A blocking check: shown with its reason, never opened. */
  closed: boolean;
  /** Over for good, ended or sold out: listed apart, under the rest. */
  finished: boolean;
  checks: RecipeCheck[];
}

/** What the checks need beyond the recipe row itself. */
export interface CheckContext {
  /** Which collection these reads were made for. */
  collection: string;
  actor: string;
  assets: AtomicAsset[];
  /** False until the wallet's NFTs have been read. */
  assetsKnown: boolean;
  /** Contract → authorized on the collection. Absent while unread, undefined when unreadable. */
  authorized: Map<string, boolean | undefined>;
  blendLimits: Map<string, BlendLimit>;
  /** Blend id → this account's use row, null when it never ran it. */
  blendUses: Map<string, BlendUse | null>;
  /** secure.nefty security id → the gate, resolved for this wallet. */
  gates: Map<string, SecurityGate>;
  /** WaxDAO blend id → this account's use row, null when it never ran it. */
  waxdaoUses: Map<string, WaxdaoUse | null>;
  /** WaxDAO farm → amount this account stakes there. Undefined while unread, null when unreadable. */
  farmStakes?: Map<string, number> | null;
  /** WaxDAO farms that are non-custodial, where being a member is the stake. */
  ncFarms?: Set<string>;
  /** Bytes the collection has on blenderizerx, undefined while unread or unreadable. */
  blenderizerRam?: number;
  /** Balance checks, keyed by tokenCheckKey. */
  tokens: Map<string, TokenCost>;
  /** Reads still on their way, for a "still checking" line. */
  loading: number;
}

export function emptyCheckContext(): CheckContext {
  return {
    collection: '', actor: '', assets: [], assetsKnown: false,
    authorized: new Map(), blendLimits: new Map(), blendUses: new Map(),
    gates: new Map(), waxdaoUses: new Map(), tokens: new Map(), loading: 0,
  };
}

/**
 * The contracts that mint into the collection when a recipe runs, and so
 * must be on its authorized_accounts. Only the three the classic panels
 * check: the others are not known to mint this way, and a wrong "not
 * authorized" would close recipes that work.
 */
const MINTS: Partial<Record<RecipeSource, string>> = {
  blend: 'blend.nefty',
  upgrade: 'up.nefty',
  drop: 'neftyblocksd',
};

export const tokenCheckKey = (quantity: string, contract = '') => `${quantity}@${contract}`;

// ─── wording ────────────────────────────────────────────────────────────

/** Seconds and milliseconds are both in use for the same fields; 0 is "none". */
const toMs = (t: number | undefined) => (!t ? 0 : t > 1e11 ? t : t * 1000);

function duration(seconds: number): string {
  if (seconds <= 0) return 'now';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

function date(ms: number): string {
  try {
    return new Date(ms).toLocaleString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** The filters a wallet is short on, as places to look for them. Tokens have no NFT page. */
function missingProof(filters: ProofFilter[], ctx: CheckContext): MarketRef[] {
  return filters
    .filter((f) => f.type !== 'TOKEN_HOLDING' && f.collection_name && proofShortfall(f, ctx.assets) > 0)
    .map((f) => ({
      collection: f.collection_name!,
      template_id: f.type === 'TEMPLATE_HOLDINGS' ? f.template_id : undefined,
      schema: f.type === 'SCHEMA_HOLDINGS' ? f.schema_name : undefined,
    }));
}

function proofText(f: ProofFilter): string {
  const n = f.amount === 1 ? '1 NFT' : `${f.amount} NFTs`;
  switch (f.type) {
    case 'TEMPLATE_HOLDINGS': return `${n} of template #${f.template_id ?? '?'}`;
    case 'SCHEMA_HOLDINGS': return `${n} of schema ${f.schema_name ?? '?'}`;
    case 'COLLECTION_HOLDINGS': return `${n} from ${f.collection_name ?? '?'}`;
    case 'TOKEN_HOLDING': {
      const what = f.token_amount || 'a token balance';
      return f.comparison_operator === 2 ? `more than ${what}`
        : f.comparison_operator === 0 ? `exactly ${what}`
          : `${what} or more`;
    }
    default: return String(f.type);
  }
}

// ─── the checks every contract shares ───────────────────────────────────

type Status = 'active' | 'upcoming' | 'ended' | 'sold_out' | 'hidden' | 'unknown';

function statusCheck(status: Status, startMs: number, endMs: number): RecipeCheck | undefined {
  const now = Date.now();
  switch (status) {
    case 'upcoming':
      return { tone: 'block', text: startMs
        ? `Opens ${date(startMs)}, in ${duration((startMs - now) / 1000)}`
        : 'Not open yet' };
    case 'ended':
      return { tone: 'block', text: endMs ? `Ended ${date(endMs)}` : 'Ended' };
    case 'sold_out':
      return { tone: 'block', text: 'Sold out' };
    case 'hidden':
      return { tone: 'block', text: 'Hidden by its creator' };
    default:
      // An end decades away is how some contracts say "no end", not news.
      return endMs && endMs > now && endMs - now < 365 * 86_400_000
        ? { tone: 'info', text: `Open until ${date(endMs)}` }
        : undefined;
  }
}

function supplyCheck(left: number, max: number, noun: string): RecipeCheck {
  return max > 0
    ? { tone: 'info', text: `${Math.max(0, left)} of ${max} ${noun} left` }
    : { tone: 'info', text: `No cap on ${noun}` };
}

/** One account's limit, read the way the contract reads it. */
function limitCheck(
  limit: number, cooldown: number, left: number | undefined, actor: string,
  resetsAtSec?: number,
): RecipeCheck {
  if (limit <= 0) return { tone: 'info', text: 'No limit per account' };
  const per = `${limit} per account${cooldown > 0 ? `, every ${duration(cooldown)}` : ''}`;
  if (!actor) return { tone: 'pending', text: `${per}. Connect a wallet to see yours` };
  if (left === undefined) return { tone: 'pending', text: `${per}. Checking yours` };
  if (left > 0) return { tone: 'ok', text: `${left} of ${limit} left for you${cooldown > 0 ? `, resets every ${duration(cooldown)}` : ''}` };
  if (cooldown <= 0) return { tone: 'block', text: `You used all ${limit}. This one does not reset` };
  const wait = resetsAtSec ? resetsAtSec - Date.now() / 1000 : 0;
  return { tone: 'block', text: wait > 0
    ? `You used all ${limit}. Yours resets in ${duration(wait)}`
    : `You used all ${limit}. Yours should reset any moment` };
}

function authCheck(ctx: CheckContext, source: RecipeSource, collection: string): RecipeCheck | undefined {
  const contract = MINTS[source];
  if (!contract) return undefined;
  const ok = ctx.authorized.get(contract);
  // Unread or unreadable is not "no": a slow indexer must not close a recipe.
  if (ok !== false) return undefined;
  return { tone: 'block', text: `${collection} does not let ${contract} mint, so this cannot run` };
}

/** What the wallet holds against what the recipe takes. */
function holdingChecks(reqs: Requirement[], ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  const nft = reqs.filter((r) => r.kind === 'nft');
  if (nft.length) {
    if (!ctx.actor) out.push({ tone: 'pending', text: 'Connect a wallet to see what you hold' });
    else if (!ctx.assetsKnown) out.push({ tone: 'pending', text: 'Reading your NFTs' });
    else {
      const short = nft.filter((r) => r.have !== undefined && r.have < r.need);
      if (short.length) {
        const first = short[0];
        out.push({ tone: 'warn', about: 'nfts', text: `You hold ${first.have} of ${first.text}`
          + (short.length > 1 ? `, and ${short.length - 1} more ingredient${short.length > 2 ? 's are' : ' is'} short` : '') });
      } else if (!reqs.some((r) => r.kind === 'other')) {
        out.push({ tone: 'ok', text: 'You hold every NFT it takes', about: 'nfts' });
      }
    }
  }
  // An ingredient Crucible does not handle (a chest, a cooldown, a rule
  // in a form it cannot judge) closes the recipe here, and says so: it
  // cannot be signed from this page, whatever the wallet holds.
  const other = reqs.filter((r) => r.kind === 'other');
  if (other.length) {
    const what = other[0].text.charAt(0).toLowerCase() + other[0].text.slice(1);
    out.push({ tone: 'block', text: `Crucible does not handle this recipe: it takes ${what}`
      + (other.length > 1 ? `, and ${other.length - 1} more ingredient${other.length > 2 ? 's' : ''} like it` : ''),
      market: other.flatMap((r) => (r.market ? [r.market] : [])) });
  }
  // A recipe can charge the same token more than once, and each payment
  // being affordable on its own says nothing about all of them together.
  // So the costs are added up per token and compared once, in total.
  const totals = new Map<string, { amount: number; decimals: number; symbol: string; contract?: string; keys: string[] }>();
  for (const r of reqs) {
    if (r.kind !== 'token' || !r.tokenQuantity) continue;
    const q = parseQuantity(r.tokenQuantity);
    if (!q) {
      out.push({ tone: 'info', text: `Costs ${r.tokenQuantity}` });
      continue;
    }
    const id = `${q.symbol}@${r.tokenContract ?? ''}`;
    const t = totals.get(id) ?? { amount: 0, decimals: q.decimals, symbol: q.symbol, contract: r.tokenContract, keys: [] };
    t.amount += q.amount;
    t.decimals = Math.max(t.decimals, q.decimals);
    t.keys.push(tokenCheckKey(r.tokenQuantity, r.tokenContract));
    totals.set(id, t);
  }
  for (const t of totals.values()) {
    const cost = `${t.amount.toFixed(t.decimals)} ${t.symbol}`;
    const read = t.keys.map((k) => ctx.tokens.get(k)).find((x) => x?.haveRaw !== undefined);
    const have = read?.haveRaw ? parseQuantity(read.haveRaw)?.amount : undefined;
    if (!ctx.actor || !read || have === undefined) out.push({ tone: 'info', text: `Costs ${cost}` });
    // Half a smallest unit of slack, so adding decimals never misreads an exact balance.
    else if (have + 0.5 * 10 ** -t.decimals >= t.amount) out.push({ tone: 'ok', text: `Costs ${cost}, you hold ${read.haveRaw}` });
    else out.push({ tone: 'warn', text: `Costs ${cost}, you hold ${read.haveRaw}` });
  }
  return out;
}

/** "12.5000 WAX" as a number, its decimals and its symbol. */
function parseQuantity(q: string): { amount: number; decimals: number; symbol: string } | undefined {
  const m = /^\s*(\d+)(?:\.(\d+))?\s+([A-Z0-9.]{1,7})\s*$/.exec(q);
  if (!m) return undefined;
  return { amount: Number(`${m[1]}.${m[2] ?? '0'}`), decimals: m[2]?.length ?? 0, symbol: m[3] };
}

/** The secure.nefty id a recipe sits behind, '' for none. */
function securityIdOf(choice: RecipeChoice): string {
  if (choice.source !== 'blend' && choice.source !== 'upgrade') return '';
  const sid = String((choice.raw as { security_id?: string | number }).security_id ?? '0');
  return sid === '0' ? '' : sid;
}

/** The gate of this recipe, once read. The lab signs with it. */
export function gateOf(choice: RecipeChoice, ctx: CheckContext): SecurityGate | undefined {
  const sid = securityIdOf(choice);
  return sid ? ctx.gates.get(sid) : undefined;
}

/**
 * What still holds the sign button once the checks pass. The gate must have
 * been read, since the transaction answers it in its own form (the account
 * for a whitelist, NFTs for an ownership gate): signed before, it went out
 * as a whitelist answer and an ownership gate refused it. And a gate the
 * wallet passes must still pass with the NFTs this transaction spends set
 * aside, because those leave the wallet before the gate is checked.
 */
export function signStops(choice: RecipeChoice, ctx: CheckContext, spent: Set<string>): string[] {
  const sid = securityIdOf(choice);
  if (!sid || !ctx.actor) return [];
  const gate = ctx.gates.get(sid);
  if (!gate) return ['Its secure.nefty gate is still being read'];
  if (gate.kind !== 'proof' || !gate.resolved?.satisfied) return [];
  return proofFor(gate, ctx.assets, spent)?.satisfied ? []
    : ['Its gate needs NFTs of its own: the ones it checks cannot be the ones this spends. Pick others, or hold more.'];
}

function gateCheck(sid: string, ctx: CheckContext): RecipeCheck {
  const gate = ctx.gates.get(sid);
  if (!gate) return { tone: 'pending', text: 'Behind a secure.nefty gate. Checking it' };
  const label = gate.name ? ` "${gate.name}"` : '';
  if (gate.kind === 'whitelist') {
    return gate.allowed === true ? { tone: 'ok', text: `You are on the whitelist${label}` }
      : gate.allowed === false ? { tone: 'block', text: `Whitelist only${label}, and you are not on it` }
        : { tone: 'pending', text: `Whitelist only${label}. Connect a wallet to check` };
  }
  if (gate.kind === 'proof') {
    const what = gate.filters.map(proofText).join(gate.logical_operator === 1 ? ' or ' : ' and ');
    return !gate.resolved ? { tone: 'pending', text: `For holders of ${what}. Connect a wallet to check` }
      : gate.resolved.satisfied ? { tone: 'ok', text: `You hold what it asks: ${what}` }
        : { tone: 'warn', text: `For holders of ${what}, which you do not hold`, market: missingProof(gate.filters, ctx) };
  }
  return { tone: 'pending', text: `Behind a secure.nefty gate${label} this page could not read` };
}

// ─── one function per contract ──────────────────────────────────────────

function dropChecks(d: DiscoveredDrop, ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  const st = statusCheck(d.status, toMs(d.start_time), toMs(d.end_time));
  if (st) out.push(st);
  if (d.status !== 'sold_out') out.push(supplyCheck(d.max_claimable - d.current_claimed, d.max_claimable, 'claims'));

  const a = d.auth;
  if (a.kind === 'public') out.push({ tone: 'ok', text: 'Open to everyone' });
  else if (a.kind === 'whitelist') {
    out.push(a.allowed === true ? { tone: 'ok', text: 'You are on the whitelist' }
      : a.allowed === false ? { tone: 'block', text: 'Whitelist only, and you are not on it' }
        : { tone: 'pending', text: 'Whitelist only. Connect a wallet to check' });
  } else if (a.kind === 'proof') {
    const what = a.filters.map(proofText).join(a.resolved?.logical_operator === 1 ? ' or ' : ' and ');
    out.push(!a.resolved ? { tone: 'pending', text: `For holders of ${what}. Connect a wallet to check` }
      : a.resolved.satisfied ? { tone: 'ok', text: `You hold what it asks: ${what}` }
        : { tone: 'warn', text: `For holders of ${what}, which you do not hold`, market: missingProof(a.filters, ctx) });
  } else if (a.kind === 'authkey') {
    out.push({ tone: 'block', text: 'Needs a secret key from its creator' });
  } else if (a.kind === 'unclaimable') {
    out.push({ tone: 'block', text: 'Restricted, and nobody has been let in yet' });
  } else {
    out.push({ tone: 'pending', text: 'Restricted. Connect a wallet to check' });
  }

  out.push(limitCheck(
    d.account_limit, d.account_limit_cooldown,
    d.account_remaining === undefined ? undefined : d.account_remaining,
    ctx.actor, d.cooldown_resets_at,
  ));

  const reqs = describeRecipe('drop', d, ctx.assets, ctx.assetsKnown)?.requirements ?? [];
  if (d.is_free) out.push({ tone: 'ok', text: 'Free' });
  else out.push(...holdingChecks(reqs, ctx));

  const auth = authCheck(ctx, 'drop', d.collection_name);
  if (auth) out.push(auth);
  return out;
}

function blendChecks(b: DiscoveredBlend, ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  const st = statusCheck(b.status, toMs(b.start_time), toMs(b.end_time));
  if (st) out.push(st);
  if (b.status !== 'sold_out') out.push(supplyCheck((b.max ?? 0) - (b.use_count ?? 0), b.max ?? 0, 'uses'));

  // The list's own whitelist answer reads every gate as a whitelist, so an
  // ownership gate came out as "not on it". The gate itself says which.
  if (b.security_id && b.security_id !== '0') out.push(gateCheck(b.security_id, ctx));

  const lim = ctx.blendLimits.get(b.blend_id);
  if (lim && lim.account_limit > 0) {
    const use = ctx.blendUses.get(b.blend_id);
    const left = use === undefined ? undefined : blendUsesLeft(lim, use ?? undefined);
    const resets = use ? use.last_claim_time + lim.account_limit_cooldown : undefined;
    out.push(limitCheck(lim.account_limit, lim.account_limit_cooldown, left, ctx.actor, resets));
  }

  if (b.is_random) out.push({ tone: 'info', text: 'The result is drawn at random' });
  const reqs = requirementsOf({ ingredients: b.ingredients ?? [] } as unknown as BlendRow, ctx.assets, ctx.assetsKnown);
  out.push(...holdingChecks(reqs, ctx));
  const auth = authCheck(ctx, 'blend', b.collection_name);
  if (auth) out.push(auth);
  return out;
}

function upgradeChecks(u: DiscoveredUpgrade, ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  const st = statusCheck(u.status, toMs(u.start_time), toMs(u.end_time));
  if (st) out.push(st);
  if (u.status !== 'sold_out') out.push(supplyCheck(u.max - u.use_count, u.max, 'uses'));
  // A gated upgrade is signed as upgradesec with the gate's check, which the
  // lab builds from the gate read here.
  if (u.security_id && u.security_id !== '0') out.push(gateCheck(u.security_id, ctx));
  // up.nefty has one kind of result value, a fixed one, so this cannot fire
  // today (see upgrades.ts). If a random kind is ever added, nothing here
  // knows how to run it, and saying so beats signing it as a fixed one.
  if (u.is_random) {
    out.push({ tone: 'block', text: 'Random results, which this page does not know how to run' });
  }
  const reqs = describeRecipe('upgrade', u, ctx.assets, ctx.assetsKnown)?.requirements ?? [];
  out.push(...holdingChecks(reqs, ctx));
  const auth = authCheck(ctx, 'upgrade', u.collection_name);
  if (auth) out.push(auth);
  return out;
}

function waxdaoChecks(b: DiscoveredWaxdaoBlend, ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  // WaxDAO stores "no end" as a far-future time, which is not worth a line.
  const end = b.end_time > 0 && b.end_time < 1e11 ? toMs(b.end_time) : 0;
  const st = statusCheck(b.status, toMs(b.start_time), end);
  if (st) out.push(st);
  if (b.status !== 'sold_out') out.push(supplyCheck(b.blends_remaining, b.max_blends, 'blends'));
  if (b.whitelist_type === 'usernames') {
    out.push(!ctx.actor ? { tone: 'pending', text: 'For listed accounts only. Connect a wallet to check' }
      : b.whitelisted_accounts.includes(ctx.actor) ? { tone: 'ok', text: 'Your account is on its list' }
        : { tone: 'block', text: 'For listed accounts only, and yours is not one' });
  } else if (b.whitelist_type === 'farm') {
    out.push(farmCheck(b, ctx));
  }
  if (b.limit_per_user > 0) out.push(waxdaoLimitCheck(b, ctx));
  const reqs = describeRecipe('waxdao', b, ctx.assets, ctx.assetsKnown)?.requirements ?? [];
  out.push(...holdingChecks(reqs, ctx));
  return out;
}

/**
 * WaxDAO's farm gate, as the contract applies it: membership, and for a
 * custodial farm the amount staked. A non-staker's blend is refused.
 */
function farmCheck(b: DiscoveredWaxdaoBlend, ctx: CheckContext): RecipeCheck {
  const farm = b.whitelisted_farmname || '?';
  const min = b.minimum_to_stake > 0 ? `, at least ${b.minimum_to_stake} staked` : '';
  const stakes = ctx.farmStakes;
  if (!ctx.actor) return { tone: 'pending', text: `For stakers in the WaxDAO farm ${farm}${min}. Connect a wallet to check` };
  if (stakes === undefined) return { tone: 'pending', text: `For stakers in the WaxDAO farm ${farm}${min}. Checking yours` };
  if (stakes === null) return { tone: 'pending', text: `For stakers in the WaxDAO farm ${farm}${min}. Your stake could not be read` };
  const mine = stakes.get(farm);
  if (mine === undefined) {
    return { tone: 'block', text: `For stakers in the WaxDAO farm ${farm}${min}, and you are not one, so WaxDAO would refuse it` };
  }
  if (mine >= b.minimum_to_stake || ctx.ncFarms?.has(farm)) return { tone: 'ok', text: `You stake in the WaxDAO farm ${farm}` };
  return { tone: 'warn', text: `For stakers of at least ${b.minimum_to_stake} in the WaxDAO farm ${farm}, and you stake ${mine}` };
}

/** WaxDAO's limit: the full allowance first, then one per cooldown, never reset. */
function waxdaoLimitCheck(b: DiscoveredWaxdaoBlend, ctx: CheckContext): RecipeCheck {
  const limit = b.limit_per_user;
  const cd = b.cooldown_reset;
  const then = cd > 0 ? `, then one every ${duration(cd)}` : '';
  if (!ctx.actor) return { tone: 'pending', text: `${limit} per account${then}. Connect a wallet to see yours` };
  const use = ctx.waxdaoUses.get(b.blend_id);
  if (use === undefined) return { tone: 'pending', text: `${limit} per account${then}. Checking yours` };
  const left = waxdaoUsesLeft(b, use ?? undefined);
  if (left > 0) {
    return use && use.quantity >= limit
      ? { tone: 'ok', text: `One left for you now, then one every ${duration(cd)}` }
      : { tone: 'ok', text: `${left} of ${limit} left for you${then}` };
  }
  if (cd <= 0) return { tone: 'block', text: `You used all ${limit}. This one does not reset` };
  const wait = use ? use.cooldown_reset - Date.now() / 1000 : 0;
  return { tone: 'block', text: `You used your ${limit}. Your next one is in ${duration(wait)}, then one every ${duration(cd)}` };
}

function blenderizerChecks(b: DiscoveredBlenderizerBlend, ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  const max = b.target_max ?? 0;
  const issued = b.target_issued ?? 0;
  if (b.status === 'sold_out') out.push({ tone: 'block', text: `Sold out: all ${max} minted` });
  else if (b.status === 'unknown') out.push({ tone: 'pending', text: 'Supply of the result could not be read' });
  else out.push(supplyCheck(max - issued, max, 'mints'));
  if (ctx.blenderizerRam !== undefined && ctx.blenderizerRam <= 0) {
    out.push({ tone: 'block', text: `${b.collection} has no RAM left on blenderizerx, so the mint would fail` });
  }
  const reqs = describeRecipe('blenderizer', b, ctx.assets, ctx.assetsKnown)?.requirements ?? [];
  out.push(...holdingChecks(reqs, ctx));
  return out;
}

function packChecks(source: RecipeSource, d: PackDesign, ctx: CheckContext): RecipeCheck[] {
  const out: RecipeCheck[] = [];
  const unlock = toMs(d.unlock_time);
  if (unlock > Date.now()) {
    out.push({ tone: 'block', text: `Opens ${date(unlock)}, in ${duration((unlock - Date.now()) / 1000)}` });
  }
  const reqs = describeRecipe(source, d, ctx.assets, ctx.assetsKnown)?.requirements ?? [];
  const pack = reqs.find((r) => r.kind === 'nft');
  if (!ctx.actor) out.push({ tone: 'pending', text: 'Connect a wallet to see your packs' });
  else if (!ctx.assetsKnown || !pack || pack.have === undefined) out.push({ tone: 'pending', text: 'Reading your NFTs' });
  else if (pack.have > 0) out.push({ tone: 'ok', text: `You own ${pack.have}` });
  else out.push({ tone: 'warn', text: 'You do not own this pack' });
  return out;
}

// ─── the verdict ────────────────────────────────────────────────────────

export function checksFor(choice: RecipeChoice, ctx: CheckContext): RecipeCheck[] {
  const raw = choice.raw;
  switch (choice.source) {
    case 'drop': return dropChecks(raw as DiscoveredDrop, ctx);
    case 'blend': return blendChecks(raw as DiscoveredBlend, ctx);
    case 'upgrade': return upgradeChecks(raw as DiscoveredUpgrade, ctx);
    case 'waxdao': return waxdaoChecks(raw as DiscoveredWaxdaoBlend, ctx);
    case 'blenderizer': return blenderizerChecks(raw as DiscoveredBlenderizerBlend, ctx);
    default: return packChecks(choice.source, raw as PackDesign, ctx);
  }
}

function statusOf(choice: RecipeChoice): Status {
  const s = (choice.raw as { status?: string }).status;
  return (s ?? 'active') as Status;
}

export function verdictFor(choice: RecipeChoice, ctx: CheckContext): RecipeVerdict {
  const checks = checksFor(choice, ctx);
  const has = (t: CheckTone) => checks.some((c) => c.tone === t);
  const tone = has('block') ? 'block' : has('warn') ? 'warn' : has('pending') ? 'pending' : 'ok';
  const status = statusOf(choice);
  return {
    tone,
    closed: tone === 'block',
    finished: status === 'ended' || status === 'sold_out',
    checks,
  };
}

/** One line for the row: the reason that matters most, or the good news. */
export function headline(v: RecipeVerdict): string {
  const first = (t: CheckTone) => v.checks.find((c) => c.tone === t)?.text;
  if (v.tone === 'block') return first('block')!;
  if (v.tone === 'warn') return first('warn')!;
  if (v.tone === 'pending') return first('pending')!;
  return 'You can run this';
}

/**
 * A blend opened from a link has no listing row behind it, only the
 * contract row. This gives it the same shape, so the check step reads it
 * with the same rules as one that was clicked.
 */
export function choiceFromBlendRow(b: BlendRow): RecipeChoice {
  const id = String(b.blend_id);
  const security = Number(b.security_id ?? 0) !== 0;
  const discovered: DiscoveredBlend = {
    blend_id: id,
    collection_name: String(b.collection_name),
    name: `Blend #${id}`,
    status: blendStatusOf(b),
    whitelist_required: security,
    security_id: String(b.security_id ?? '0'),
    is_random: !isDeterministic(b).ok,
    ingredients: b.ingredients,
    max: Number(b.max ?? 0),
    use_count: Number(b.use_count ?? 0),
    start_time: Number(b.start_time ?? 0),
    end_time: Number(b.end_time ?? 0),
  };
  return { source: 'blend', raw: discovered, id, name: discovered.name, note: '', live: discovered.status === 'active' };
}

// ─── the reads ──────────────────────────────────────────────────────────

/**
 * Fills the context for these recipes, a piece at a time, calling `onUpdate`
 * after each so the list sharpens as answers arrive. Every read is per
 * collection or per limited recipe, never per row of the list:
 *
 *   one collection read for which contracts may mint,
 *   one ranged read of blend limits, then one per limited blend for yours,
 *   two or three secure.nefty reads per distinct gate,
 *   one WaxDAO read per limited WaxDAO blend for yours,
 *   one waxdaofarmer read for your farms when a blend is farm-gated,
 *   one blenderizerx RAM read when a Blenderizer recipe is listed,
 *   one balance read per distinct token cost, at most twelve.
 *
 * A failed read leaves its part unknown, which no check treats as a "no".
 */
export async function loadCheckContext(
  ctx: CheckContext, choices: RecipeChoice[], collection: string, onUpdate: () => void,
): Promise<void> {
  const actor = ctx.actor;
  const tasks: Promise<void>[] = [];
  const track = (p: Promise<void>) => {
    ctx.loading += 1;
    tasks.push(p.catch(() => { /* unknown stays unknown */ }).finally(() => {
      ctx.loading -= 1;
      onUpdate();
    }));
  };

  const contracts = new Set(choices.map((c) => MINTS[c.source]).filter((c): c is string => !!c));
  for (const contract of contracts) {
    if (ctx.authorized.has(contract)) continue;
    track(isContractAuthorized(collection, contract).then((ok) => { ctx.authorized.set(contract, ok); }));
  }

  const blendIds = choices.filter((c) => c.source === 'blend').map((c) => c.id);
  const unreadLimits = blendIds.filter((id) => !ctx.blendLimits.has(id));
  if (unreadLimits.length) {
    track(readBlendLimits(unreadLimits).then(async (limits) => {
      for (const [id, l] of limits) ctx.blendLimits.set(id, l);
      if (!actor) return;
      const limited = [...limits.values()].filter((l) => l.account_limit > 0 && !ctx.blendUses.has(l.blend_id));
      onUpdate();
      // A handful of point reads; the contract keeps one row per account.
      for (let i = 0; i < limited.length; i += 6) {
        await Promise.all(limited.slice(i, i + 6).map(async (l) => {
          try {
            ctx.blendUses.set(l.blend_id, (await readBlendUse(l.blend_id, actor)) ?? null);
          } catch { /* stays unknown */ }
        }));
        onUpdate();
      }
    }));
  }

  const sids = new Set(choices.map(securityIdOf).filter((sid) => sid && !ctx.gates.has(sid)));
  for (const sid of sids) {
    track(readSecurityGate(collection, sid, actor, ctx.assets).then((g) => { ctx.gates.set(sid, g); }));
  }

  if (actor && ctx.farmStakes === undefined
      && choices.some((c) => c.source === 'waxdao' && (c.raw as DiscoveredWaxdaoBlend).whitelist_type === 'farm')) {
    const farms = choices.filter((c) => c.source === 'waxdao' && (c.raw as DiscoveredWaxdaoBlend).whitelist_type === 'farm')
      .map((c) => (c.raw as DiscoveredWaxdaoBlend).whitelisted_farmname);
    track(Promise.all([readFarmStakes(actor), readNonCustodialFarms(farms).catch(() => new Set<string>())])
      .then(([m, nc]) => { ctx.farmStakes = m; ctx.ncFarms = nc; }, () => { ctx.farmStakes = null; }));
  }

  if (actor) {
    const limited = choices.filter((c) => c.source === 'waxdao'
      && (c.raw as DiscoveredWaxdaoBlend).limit_per_user > 0 && !ctx.waxdaoUses.has(c.id));
    for (let i = 0; i < limited.length; i += 6) {
      const batch = limited.slice(i, i + 6);
      track(Promise.all(batch.map(async (c) => {
        try {
          ctx.waxdaoUses.set(c.id, (await readWaxdaoUse(c.id, actor)) ?? null);
        } catch { /* stays unknown */ }
      })).then(() => undefined));
    }
  }

  if (choices.some((c) => c.source === 'blenderizer') && ctx.blenderizerRam === undefined) {
    track(readBlenderizerRam(collection).then((r) => { ctx.blenderizerRam = r ? r.bytes : 0; }));
  }

  if (actor) {
    const wanted = new Map<string, { quantity: string; contract?: string }>();
    for (const c of choices) {
      for (const r of requirementsOfChoice(c, ctx)) {
        if (r.kind !== 'token' || !r.tokenQuantity) continue;
        const key = tokenCheckKey(r.tokenQuantity, r.tokenContract);
        if (!ctx.tokens.has(key) && !wanted.has(key)) wanted.set(key, { quantity: r.tokenQuantity, contract: r.tokenContract });
      }
    }
    for (const [key, t] of [...wanted].slice(0, 12)) {
      track(checkTokenCost(actor, t.quantity, t.contract).then((cost) => { if (cost) ctx.tokens.set(key, cost); }));
    }
  }

  await Promise.all(tasks);
}

function requirementsOfChoice(c: RecipeChoice, ctx: CheckContext): Requirement[] {
  if (c.source === 'blend') {
    const b = c.raw as DiscoveredBlend;
    return requirementsOf({ ingredients: b.ingredients ?? [] } as unknown as BlendRow, ctx.assets, ctx.assetsKnown);
  }
  return describeRecipe(c.source, c.raw, ctx.assets, ctx.assetsKnown)?.requirements ?? [];
}

