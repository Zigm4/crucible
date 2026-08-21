/**
 * WharfKit SessionKit wiring.
 *
 * Exposes login() / logout() / restoreSession() / getCurrentSession() to
 * the rest of the app. The kit is configured with two wallets:
 *   - Anchor (desktop / mobile)
 *   - WAX Cloud Wallet (in-browser)
 *
 * All cryptographic operations happen inside the wallet, this module
 * never sees a private key.
 */
import { SessionKit, type Session } from '@wharfkit/session';
import { WebRenderer } from '@wharfkit/web-renderer';
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor';
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet';

import { WAX_CHAIN_ID, WAX_RPC_ENDPOINTS } from './rpc';

let kit: SessionKit | undefined;
let current: Session | undefined;

export function getSessionKit(): SessionKit {
  if (!kit) {
    kit = new SessionKit({
      appName: 'Crucible',
      chains: [
        {
          id: WAX_CHAIN_ID,
          url: WAX_RPC_ENDPOINTS[0],
        },
      ],
      ui: new WebRenderer(),
      walletPlugins: [
        new WalletPluginAnchor(),
        new WalletPluginCloudWallet(),
      ],
    });
  }
  return kit;
}

export function getCurrentSession(): Session | undefined {
  return current;
}

export async function restoreSession(): Promise<Session | undefined> {
  const restored = await getSessionKit().restore();
  current = restored ?? undefined;
  return current;
}

export async function login(): Promise<Session> {
  const result = await getSessionKit().login();
  current = result.session;
  return current;
}

export async function logout(): Promise<void> {
  if (current) {
    await getSessionKit().logout(current);
    current = undefined;
  }
}

/**
 * Every account this browser has already attached, not just the last one.
 *
 * SessionKit keeps a session per account and restores whichever was used
 * last. Without a way to list them, switching accounts meant disconnecting
 * and going back through the wallet, even though both were already there.
 */
export interface KnownSession {
  actor: string;
  permission: string;
  /** The one `restore()` picks with no arguments. */
  isDefault: boolean;
}

export async function listSessions(): Promise<KnownSession[]> {
  try {
    const stored = await getSessionKit().getSessions();
    return stored
      .map((s) => ({
        // Serialized sessions carry Antelope types, so never compare raw.
        actor: String(s.actor),
        permission: String(s.permission),
        isDefault: s.default === true,
      }))
      // Storage order is the order they were attached, which is no help to
      // someone holding dozens of names. Alphabetical is at least a place
      // to look.
      .sort((a, b) => a.actor.localeCompare(b.actor) || a.permission.localeCompare(b.permission));
  } catch {
    return [];
  }
}

/**
 * Moves to an account already attached, without a wallet round trip.
 *
 * Returns undefined when that session is gone, in which case the caller
 * should fall back to a full login rather than assume it worked.
 */
export async function switchSession(
  actor: string,
  permission: string,
): Promise<Session | undefined> {
  const restored = await getSessionKit().restore({
    chain: WAX_CHAIN_ID,
    actor,
    permission,
  });
  if (!restored) return undefined;
  current = restored;
  // So a reload comes back to the account the user last chose.
  await getSessionKit().persistSession(restored, true);
  return current;
}
