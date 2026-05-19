/**
 * Local "Simulate" pre-flight.
 *
 * Given the same action array we'd hand to `session.transact()`, this module
 * serializes each action through the contract's live ABI using WharfKit's
 * `Action.from(...)` and returns the resulting hex per action. Nothing is
 * broadcast; no signature is requested. The user gets a deterministic
 * preview of exactly what their wallet would be asked to sign.
 *
 * We deliberately don't use the chain's /v1/chain/abi_json_to_bin, that
 * endpoint is disabled on most public WAX nodes since 2024.
 */
import { Action } from '@wharfkit/session';

import { withFailover } from '../chain/rpc';

/**
 * Locally serialises each action against the contract's live ABI via the
 * WharfKit `Action.from(..., abi)` helper. The hex output matches what the
 * chain's deprecated /v1/chain/abi_json_to_bin used to produce, but since
 * most public nodes have disabled that endpoint, we do it client-side.
 *
 * No transaction is sent. No signature is requested. We only validate the
 * payload would serialise cleanly.
 */
export async function dryRunActions(
  actions: { account: string; name: string; authorization: { actor: string; permission: string }[]; data: Record<string, unknown> }[],
): Promise<{ action: string; bin?: string; error?: string }[]> {
  // group by contract account so we fetch each ABI once
  const accounts = [...new Set(actions.map((a) => a.account))];
  const abis = new Map<string, unknown>();
  await withFailover(async (client) => {
    for (const code of accounts) {
      const res = await client.v1.chain.get_abi(code);
      if (!res.abi) throw new Error(`No ABI for ${code}`);
      abis.set(code, res.abi);
    }
  });

  const out: { action: string; bin?: string; error?: string }[] = [];
  for (const a of actions) {
    const tag = `${a.account}::${a.name}`;
    try {
      const action = Action.from(
        {
          account: a.account,
          name: a.name,
          authorization: a.authorization,
          data: a.data,
        },
        abis.get(a.account) as Parameters<typeof Action.from>[1],
      );
      // The serialised payload sits in action.data as a Bytes-like object.
      const bytes = action.data as unknown as { hexString?: string; toString?: (e: string) => string };
      const hex = bytes.hexString ?? (bytes.toString ? bytes.toString('hex') : String(bytes));
      out.push({ action: tag, bin: hex });
    } catch (err) {
      out.push({ action: tag, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
