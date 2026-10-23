/**
 * Asks the chain whether a transaction would go through, before signing it.
 * ─────────────────────────────────────────────────────────────
 * `compute_transaction` makes a node execute a transaction exactly as it
 * would a signed one, against the live tables, and report what happened,
 * without signatures and without writing anything. It is how every rule
 * this app relies on was settled (scripts/verify-*.mjs), and it answers
 * what no check written here can foresee: a contract changed since, a
 * limit read a minute ago, an account out of RAM.
 *
 * The answer falls into four kinds, because they call for different things:
 *
 *   accepted     the chain would take it; what it would mint is counted
 *   refused      a contract said no (an assertion, or RAM the account
 *                lacks), and signing would fail the same way
 *   resources    the account's own CPU or NET would not cover it. Not a
 *                refusal: a wallet that pays for its users' transactions
 *                (WAX Cloud Wallet, a resource provider) adds its own
 *                payment when it signs, which this check cannot see
 *   unavailable  no node gave an answer, so nothing is known either way
 *
 * Nodes are tried in the same order as every other read. A refusal is an
 * answer and is returned at once; only a node that does not answer at all
 * moves the question to the next one.
 */
import { Action, APIClient, SignedTransaction } from '@wharfkit/session';

import type { BuiltAction } from './action';
import { WAX_RPC_ENDPOINTS } from './rpc';

export type Simulation =
  | { kind: 'accepted'; mints: number; burns: number }
  | { kind: 'refused'; reason: string }
  | { kind: 'resources'; reason: string }
  | { kind: 'unavailable'; reason: string };

const NODE_TIMEOUT_MS = 8_000;
/**
 * The whole question, across every node. The sign button waits on the
 * answer, so a run of slow nodes must not hold it for a minute: past this,
 * the answer is "unavailable" and signing is free to go ahead.
 */
const OVERALL_TIMEOUT_MS = 15_000;

/** An account's own resources ran short, which a paying wallet can cover. */
const RESOURCE_ERRORS = new Set([
  'tx_cpu_usage_exceeded', 'tx_net_usage_exceeded', 'leeway_deadline_exception', 'deadline_exception',
  'greylist_cpu_usage_exceeded', 'greylist_net_usage_exceeded', 'block_cpu_usage_exceeded', 'block_net_usage_exceeded',
]);
/** A contract, or the account's RAM, said no: signing fails the same way. */
const REFUSALS = new Set(['eosio_assert_message_exception', 'eosio_assert_code_exception', 'ram_usage_exceeded']);

const abis = new Map<string, unknown>();

async function abiOf(client: APIClient, account: string): Promise<unknown> {
  if (!abis.has(account)) {
    const res = await client.v1.chain.get_abi(account);
    if (!res.abi) throw new Error(`No ABI for ${account}`);
    abis.set(account, res.abi);
  }
  return abis.get(account);
}

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** The chain's error, from a thrown APIError or from `processed.except`. */
function chainError(e: unknown): { name: string; message: string } | undefined {
  const err = (e as { error?: unknown })?.error ?? e;
  const name = (err as { name?: unknown })?.name;
  if (typeof name !== 'string' || !/_exception$|_exceeded$/.test(name)) return undefined;
  const s = JSON.stringify(err);
  // An assertion's own words sit in the stack as `"data":{"s":"..."}`, or
  // in the details as "assertion failure with message: ...".
  const asserted = /"data":\{"s":"([^"]+)"/.exec(s)?.[1]
    ?? /assertion failure with message: ([^"\\]+)/.exec(s)?.[1];
  const detail = /"message":"([^"]+)"/.exec(s)?.[1];
  return { name, message: (asserted ?? detail ?? String((err as { what?: unknown }).what ?? name)).trim() };
}

function classify(name: string, message: string): Simulation {
  if (RESOURCE_ERRORS.has(name)) return { kind: 'resources', reason: message };
  if (name === 'ram_usage_exceeded') return { kind: 'refused', reason: `Your account does not have enough RAM for this (${message})` };
  if (REFUSALS.has(name)) return { kind: 'refused', reason: message };
  // Anything else is not a verdict on the recipe, so it does not block.
  return { kind: 'unavailable', reason: message };
}

/** Runs `actions` through compute_transaction, as their signer, and says what the chain would do. */
export async function simulateActions(actions: BuiltAction[]): Promise<Simulation> {
  if (!actions.length) return { kind: 'unavailable', reason: 'nothing to check' };
  return timeout(askNodes(actions), OVERALL_TIMEOUT_MS)
    .catch(() => ({ kind: 'unavailable' as const, reason: `no node answered within ${OVERALL_TIMEOUT_MS / 1000}s` }));
}

async function askNodes(actions: BuiltAction[]): Promise<Simulation> {
  let last = '';
  for (const url of WAX_RPC_ENDPOINTS) {
    const client = new APIClient({ url });
    try {
      const built = await timeout(Promise.all(actions.map(async (a) =>
        Action.from(a, (await abiOf(client, a.account)) as Parameters<typeof Action.from>[1]))), NODE_TIMEOUT_MS);
      const info = await timeout(client.v1.chain.get_info(), NODE_TIMEOUT_MS);
      const tx = SignedTransaction.from({ ...info.getTransactionHeader(120), actions: built, signatures: [] });
      const res = await timeout(client.v1.chain.compute_transaction(tx), NODE_TIMEOUT_MS);
      const processed = res.processed as unknown as { except?: unknown; action_traces?: unknown[] };
      if (processed.except) {
        const ce = chainError(processed.except);
        return ce ? classify(ce.name, ce.message) : { kind: 'unavailable', reason: 'the node answered without saying why' };
      }
      const all = JSON.stringify(processed.action_traces ?? []);
      return {
        kind: 'accepted',
        mints: (all.match(/"name":"mintasset"/g) ?? []).length,
        burns: (all.match(/"name":"burnasset"/g) ?? []).length,
      };
    } catch (e) {
      const ce = chainError(e);
      if (ce) return classify(ce.name, ce.message);
      last = e instanceof Error ? e.message : String(e);
    }
  }
  return { kind: 'unavailable', reason: last || 'no node answered' };
}
