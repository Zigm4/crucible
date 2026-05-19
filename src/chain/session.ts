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
