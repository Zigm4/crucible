/**
 * The two things every contract module needs, and nothing else.
 *
 * `rpc.ts` is failover over public WAX endpoints: each call races a list
 * of hosts with a per-request deadline, because a dead RPC node usually
 * hangs rather than refusing, and a strict try-then-timeout chain would
 * spend the whole budget on the first bad host.
 *
 * `session.ts` is the wallet. It is the ONLY place in the project that
 * signs anything, and the only place that persists to localStorage.
 * Replace it and the rest of the code is unchanged: every builder returns
 * a plain `BuiltAction` and never asks who will sign it.
 */
export type { BuiltAction } from './action';
export {
  getApiClient,
  withFailover,
  getTableRows,
  getAccount,
  getAccountInfo,
  getCodeHash,
  getLastAction,
  atomicFetch,
  WAX_CHAIN_ID,
  WAX_RPC_ENDPOINTS,
  ATOMIC_API_ENDPOINTS,
  HYPERION_ENDPOINTS,
  type GetTableRowsArgs,
  type LastAction,
} from './rpc';
export { getSessionKit, getCurrentSession, restoreSession, login, logout } from './session';
