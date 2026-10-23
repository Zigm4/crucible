/**
 * The gate a NeftyBlocks blend or upgrade sits behind, read from secure.nefty.
 *
 * A recipe with a security_id is checked by secure.nefty when it runs, and
 * secure.nefty knows two kinds of gate, both scoped to the collection:
 *
 *   security   (scope collection, pk id)  id, name, description, type
 *     type 0   whitelist  whitelists (scope security_id, pk account)
 *     type 1   ownership  proofown   (scope collection, pk security_id)
 *
 * The signer has to say which one it is passing: WHITELIST_CHECK names the
 * account, OWNERSHIP_CHECK also lists the NFTs that prove the holding. The
 * runner always sent the whitelist form, so every ownership-gated blend
 * failed on chain, and the lists read every gate as a whitelist and called
 * the visitor "not on it".
 *
 * The proof uses the same LOGICAL_GROUP shape as a drop's, and is resolved by
 * the same rule (drops.ts), so a holding means the same thing on both.
 */
import { getTableRows } from '../chain/rpc';
import {
  parseProofFilters, readProofBalances, resolveProof,
  type ListDropsOpts, type ProofBalances, type ProofFilter, type ProofResolution,
} from './drops';
import type { SecurityCheck } from './rngExecute';

const SECURE = 'secure.nefty';

export type SecurityGate =
  | { kind: 'whitelist'; security_id: string; name: string; allowed?: boolean }
  | {
      kind: 'proof'; security_id: string; name: string;
      filters: ProofFilter[]; logical_operator: number; resolved?: ProofResolution;
      /** Balances the token filters were judged against. */
      balances?: ProofBalances;
    }
  /** No such security on the collection, or a type this page does not know. */
  | { kind: 'unknown'; security_id: string; name: string };

const cache = new Map<string, Promise<SecurityGate>>();

/**
 * Reads one gate and, when there is a wallet, whether it lets that wallet
 * through. Two or three point reads, cached per collection, gate and wallet.
 */
export function readSecurityGate(
  collection: string,
  securityId: string,
  actor: string,
  owned: ListDropsOpts['ownedAssets'] = [],
): Promise<SecurityGate> {
  const key = `${collection}:${securityId}:${actor}:${owned.length}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = loadGate(collection, securityId, actor, owned);
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
  }
  return hit;
}

async function loadGate(
  collection: string,
  securityId: string,
  actor: string,
  owned: ListDropsOpts['ownedAssets'],
): Promise<SecurityGate> {
  const [row] = await getTableRows<{ id: number | string; name: string; type: number | string }>({
    code: SECURE, scope: collection, table: 'security',
    lower_bound: securityId, upper_bound: securityId, limit: 1,
  });
  const name = row ? String(row.name ?? '') : '';
  const type = row ? Number(row.type) : NaN;

  if (type === 0) {
    if (!actor) return { kind: 'whitelist', security_id: securityId, name };
    // One row by its key, not the first thousand: a long whitelist would
    // otherwise say "not on it" to everybody past the first page.
    const rows = await getTableRows<{ account: string }>({
      code: SECURE, scope: securityId, table: 'whitelists',
      lower_bound: actor, upper_bound: actor, key_type: 'name', limit: 1,
    });
    return { kind: 'whitelist', security_id: securityId, name, allowed: rows.some((r) => r.account === actor) };
  }

  if (type === 1) {
    const [proof] = await getTableRows<{
      security_id: number | string;
      group: { logical_operator: number; filters: Array<[string, Record<string, unknown>]> };
    }>({
      code: SECURE, scope: collection, table: 'proofown',
      lower_bound: securityId, upper_bound: securityId, limit: 1,
    });
    if (!proof) return { kind: 'unknown', security_id: securityId, name };
    const filters = parseProofFilters(proof.group);
    const logical_operator = Number(proof.group.logical_operator) || 0;
    const balances = actor ? await readProofBalances(filters, actor).catch(() => undefined) : undefined;
    return {
      kind: 'proof', security_id: securityId, name, filters, logical_operator, balances,
      resolved: actor ? resolveProof(filters, logical_operator, owned, balances) : undefined,
    };
  }

  return { kind: 'unknown', security_id: securityId, name };
}

/**
 * The proof for an ownership gate, from NFTs other than `spent`.
 *
 * The ingredients leave the wallet in the same transaction, before the gate
 * is checked, so an NFT that is burned or paid in cannot also be the one
 * that proves the holding. A wallet with exactly enough for both would read
 * as fine and fail on chain.
 */
export function proofFor(
  gate: SecurityGate | undefined,
  owned: ListDropsOpts['ownedAssets'] = [],
  spent: Set<string> = new Set(),
): ProofResolution | undefined {
  if (gate?.kind !== 'proof') return undefined;
  return resolveProof(gate.filters, gate.logical_operator, owned.filter((a) => !spent.has(a.asset_id)), gate.balances);
}

/** What to sign for this gate: the NFTs that prove it, or just the account. */
export function securityCheckFor(
  gate: SecurityGate | undefined, actor: string, proof?: ProofResolution,
): SecurityCheck {
  const p = proof ?? (gate?.kind === 'proof' ? gate.resolved : undefined);
  if (gate?.kind === 'proof' && p?.satisfied) {
    return { kind: 'ownership', account_name: actor, asset_ids: p.asset_ids };
  }
  return { kind: 'whitelist', account_name: actor };
}
