/**
 * The one shape every contract module in this project produces.
 *
 * An action is what a wallet is asked to sign. Building one is pure: no
 * network, no DOM, no session. That is what lets `scripts/verify-*.mjs`
 * import a builder in Node, hand it the decoded payload of a real
 * historical transaction, and compare the result byte for byte against
 * what was actually signed on chain.
 *
 * It lives in `chain/` rather than under any one contract family because
 * `nefty/`, `waxdao/` and `blenderizer/` all emit it, and none of them
 * should have to depend on another to say so.
 */
export interface BuiltAction {
  /** The contract account, e.g. `blend.nefty`. */
  account: string;
  /** The action name, e.g. `nosecfuse`. */
  name: string;
  authorization: { actor: string; permission: string }[];
  /**
   * The unserialised arguments, keyed by the ABI's field NAMES. WharfKit
   * serialises them against the live ABI, so field order does not matter
   * but spelling does.
   */
  data: Record<string, unknown>;
}
