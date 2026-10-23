/**
 * Holder gates: let in whoever holds what a rule names.
 * ─────────────────────────────────────────────────────────────
 * The other half of "who can use it", next to account lists
 * (accessLists.ts). A rule is a LOGICAL_GROUP: filters joined by "all of
 * them" (0) or "any of them" (1), each one a holding of NFTs (a template,
 * a schema or a whole collection) or of a token. Two contracts keep them:
 *
 *   secure.nefty   a collection's gate of type 1, shared by its blends and
 *                  upgrades: addproofown makes one (id from the `security`
 *                  counter, like a list), setproofown rewrites its rule.
 *   neftyblocksd   a drop's own rule: setproofown, delproofown. The drop
 *                  must have auth_required set ("Drop is not secure").
 *
 * Settled through compute_transaction, never signed (scripts/verify-holder-gates.mjs):
 *   - at least one filter, every amount above 0
 *   - an NFT filter takes "more than" (2) or "at least" (3) only; 0, 1, 4
 *     and 5 are refused on both contracts. A token filter takes all six.
 *   - a template or schema must belong to the collection its filter names,
 *     and that collection must exist; it need not be the recipe's own
 *   - a token amount must be written at the precision of its symbol
 *   - a gate's name is 50 characters at most
 *   - delproofown removes the rule but leaves the gate, even while blends
 *     still point at it: nothing on chain protects a gate in use, so this
 *     module only offers to delete one no recipe uses, and then removes
 *     both (delproofown, delsecurity). A list in use by a blend is refused
 *     by the chain itself ("Security is used by a super blend").
 *   - delsecurity reads the collection's blends to make that check, and in
 *     some collections fails on one of them ("invalid variant index":
 *     bluemob4life, captainshelm). There no gate can be deleted at all, so
 *     the gate list asks the chain first and offers only what it accepts.
 */
import type { BuiltAction } from '../chain/action';
import { getTableRows } from '../chain/rpc';

/** "at least" is what nearly every gate on chain uses; "more than" is the other operator NFT filters accept. */
export type HolderRule =
  | { kind: 'template'; collection: string; template_id: number; amount: number; more: boolean }
  | { kind: 'schema'; collection: string; schema_name: string; amount: number; more: boolean }
  | { kind: 'collection'; collection: string; amount: number; more: boolean }
  /** `amount` is an asset string, e.g. "10.00000000 WAX"; `op` any of the six comparisons. */
  | { kind: 'token'; contract: string; amount: string; op: number };

export interface HolderGroup {
  /** true: any one filter is enough; false: all of them. */
  any: boolean;
  rules: HolderRule[];
}

/** Token comparisons, as the contracts number them. */
export const TOKEN_OPS: { op: number; label: string }[] = [
  { op: 3, label: 'at least' }, { op: 2, label: 'more than' }, { op: 0, label: 'exactly' },
  { op: 5, label: 'at most' }, { op: 4, label: 'less than' }, { op: 1, label: 'anything but' },
];

type Variant = [string, Record<string, unknown>];

/** "10.00000000 WAX" -> "8,WAX", or '' when it is not an asset string. */
export function symbolOf(asset: string): string {
  const m = /^(\d+)(?:\.(\d+))?\s+([A-Z]{1,7})$/.exec(asset.trim());
  return m ? `${(m[2] ?? '').length},${m[3]}` : '';
}

export function encodeGroup(g: HolderGroup): { logical_operator: number; filters: Variant[] } {
  const op = (more: boolean) => (more ? 2 : 3);
  return {
    logical_operator: g.any ? 1 : 0,
    filters: g.rules.map((r): Variant => {
      switch (r.kind) {
        case 'template':
          return ['TEMPLATE_HOLDINGS', { collection_name: r.collection, template_id: r.template_id, comparison_operator: op(r.more), amount: r.amount }];
        case 'schema':
          return ['SCHEMA_HOLDINGS', { collection_name: r.collection, schema_name: r.schema_name, comparison_operator: op(r.more), amount: r.amount }];
        case 'collection':
          return ['COLLECTION_HOLDINGS', { collection_name: r.collection, comparison_operator: op(r.more), amount: r.amount }];
        case 'token':
          return ['TOKEN_HOLDING', { token_contract: r.contract, token_symbol: symbolOf(r.amount), comparison_operator: r.op, amount: r.amount.trim() }];
      }
    }),
  };
}

/** A rule as the contracts hold it, or undefined for a shape the editor does not offer. */
export function decodeGroup(raw: { logical_operator?: unknown; filters?: unknown[] } | undefined): HolderGroup | undefined {
  if (!raw || !Array.isArray(raw.filters)) return undefined;
  const lo = Number(raw.logical_operator);
  if (lo !== 0 && lo !== 1) return undefined;
  const rules: HolderRule[] = [];
  for (const f of raw.filters) {
    const [type, d] = (Array.isArray(f) ? f : []) as [string?, Record<string, unknown>?];
    if (!type || !d) return undefined;
    const op = Number(d.comparison_operator);
    if (type === 'TOKEN_HOLDING') {
      rules.push({ kind: 'token', contract: String(d.token_contract ?? ''), amount: String(d.amount ?? ''), op });
      continue;
    }
    if (op !== 2 && op !== 3) return undefined;
    const collection = String(d.collection_name ?? ''), amount = Number(d.amount ?? 0), more = op === 2;
    if (type === 'TEMPLATE_HOLDINGS') rules.push({ kind: 'template', collection, template_id: Number(d.template_id), amount, more });
    else if (type === 'SCHEMA_HOLDINGS') rules.push({ kind: 'schema', collection, schema_name: String(d.schema_name ?? ''), amount, more });
    else if (type === 'COLLECTION_HOLDINGS') rules.push({ kind: 'collection', collection, amount, more });
    else return undefined;
  }
  return { any: lo === 1, rules };
}

/** A rule in one sentence, for the review and for gates listed elsewhere. */
export function describeGroup(g: HolderGroup, templateName: (id: number) => string = (id) => `template #${id}`): string {
  const parts = g.rules.map((r) => {
    if (r.kind === 'token') {
      const op = TOKEN_OPS.find((o) => o.op === r.op)?.label ?? `comparison ${r.op}`;
      return `${op} ${r.amount} (${r.contract})`;
    }
    const n = r.more ? `more than ${r.amount}` : `at least ${r.amount}`;
    if (r.kind === 'template') return `${n} ${templateName(r.template_id)}`;
    if (r.kind === 'schema') return `${n} NFT(s) of the schema ${r.schema_name} (${r.collection})`;
    return `${n} NFT(s) of ${r.collection}`;
  });
  return parts.join(g.any ? ', or ' : ', and ');
}

/** What the contracts would refuse in a rule, said before signing. */
export function groupProblems(g: HolderGroup): string[] {
  const out: string[] = [];
  if (!g.rules.length) out.push('A holder rule needs at least one thing to hold.');
  g.rules.forEach((r, i) => {
    const at = `Holding ${i + 1}`;
    if (r.kind === 'token') {
      if (!symbolOf(r.amount)) out.push(`${at}: "${r.amount || 'empty'}" is not a token amount. Write it with the token's exact decimals, e.g. 10.00000000 WAX.`);
      else if (!/[1-9]/.test(r.amount)) out.push(`${at}: the amount must be above 0.`);
      if (!r.contract.trim()) out.push(`${at}: name the token's contract, e.g. eosio.token.`);
      return;
    }
    if (!(r.amount > 0)) out.push(`${at}: the number of NFTs must be at least 1.`);
    if (!r.collection.trim()) out.push(`${at}: name the collection.`);
    if (r.kind === 'template' && !(r.template_id > 0)) out.push(`${at}: pick a template.`);
    if (r.kind === 'schema' && !r.schema_name.trim()) out.push(`${at}: pick a schema.`);
  });
  return out;
}

export const MAX_GATE_NAME = 50;

// ─── reading ────────────────────────────────────────────────────────────

/** A collection gate's rule, or undefined when it has none. */
export async function readCollectionRule(collection: string, security_id: string): Promise<{ raw: unknown; group?: HolderGroup } | undefined> {
  const [row] = await getTableRows<{ group: { logical_operator: number; filters: unknown[] } }>({
    code: 'secure.nefty', scope: collection, table: 'proofown', lower_bound: security_id, upper_bound: security_id, limit: 1,
  });
  return row ? { raw: row.group, group: decodeGroup(row.group) } : undefined;
}

/** A drop's own rule, or undefined when it has none. */
export async function readDropRule(drop_id: string): Promise<{ raw: unknown; group?: HolderGroup } | undefined> {
  const [row] = await getTableRows<{ drop_id: number | string; group: { logical_operator: number; filters: unknown[] } }>({
    code: 'neftyblocksd', scope: 'neftyblocksd', table: 'proofown', lower_bound: drop_id, upper_bound: drop_id, limit: 1,
  });
  return row && String(row.drop_id) === drop_id ? { raw: row.group, group: decodeGroup(row.group) } : undefined;
}

/** A token's decimals from its own stat table, or undefined when the contract has no such token. */
export async function tokenDecimals(contract: string, code: string): Promise<number | undefined> {
  const rows = await getTableRows<{ supply: string }>({ code: contract, scope: code, table: 'stat', limit: 1 });
  const supply = rows[0]?.supply;
  if (!supply) return undefined;
  return (supply.split(' ')[0].split('.')[1] ?? '').length;
}

// ─── writing ────────────────────────────────────────────────────────────

const by = (actor: string) => [{ actor, permission: 'active' }];

export function buildAddHolderGate(actor: string, collection: string, name: string, g: HolderGroup): BuiltAction {
  return {
    account: 'secure.nefty', name: 'addproofown', authorization: by(actor),
    data: { authorized_account: actor, collection_name: collection, proof_name: name, description: '', group: encodeGroup(g) },
  };
}

export function buildSetHolderGate(actor: string, collection: string, security_id: string | number, g: HolderGroup): BuiltAction {
  return {
    account: 'secure.nefty', name: 'setproofown', authorization: by(actor),
    data: { authorized_account: actor, collection_name: collection, security_id: String(security_id), group: encodeGroup(g) },
  };
}

/** Both halves of a holder gate: the rule, then the gate. Only for a gate no recipe uses. */
export function buildDeleteHolderGate(actor: string, collection: string, security_id: string | number): BuiltAction[] {
  const data = { authorized_account: actor, collection_name: collection, security_id: String(security_id) };
  return [
    { account: 'secure.nefty', name: 'delproofown', authorization: by(actor), data },
    { account: 'secure.nefty', name: 'delsecurity', authorization: by(actor), data },
  ];
}

/** A list, whoever is still on it. The chain refuses it while a blend uses the list. */
export function buildDeleteList(actor: string, collection: string, security_id: string | number): BuiltAction {
  return {
    account: 'secure.nefty', name: 'delsecurity', authorization: by(actor),
    data: { authorized_account: actor, collection_name: collection, security_id: String(security_id) },
  };
}

export function buildSetDropRule(actor: string, drop_id: string | number, g: HolderGroup): BuiltAction {
  return {
    account: 'neftyblocksd', name: 'setproofown', authorization: by(actor),
    data: { authorized_account: actor, drop_id: String(drop_id), group: encodeGroup(g) },
  };
}

export function buildDelDropRule(actor: string, drop_id: string | number): BuiltAction {
  return {
    account: 'neftyblocksd', name: 'delproofown', authorization: by(actor),
    data: { authorized_account: actor, drop_id: String(drop_id) },
  };
}
