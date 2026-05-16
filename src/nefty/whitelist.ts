import { getTableRows } from '../chain/rpc';

interface WhitelistRow {
  account?: string;
  name?: string;
  [k: string]: unknown;
}

export interface WhitelistStatus {
  required: boolean;
  allowed?: boolean;
  reason?: string;
}

/**
 * If the blend declares a security_id > 0, the blend.nefty contract delegates
 * an access check to secure.nefty. The typical flavor stores a per-account
 * whitelist scoped by security_id. We accept several plausible row shapes
 * because the contract's secure.nefty schema isn't versioned here — we only
 * need to know "is `actor` listed somewhere in this whitelist?".
 */
export async function checkWhitelist(args: {
  security_id: string | number | undefined;
  actor: string;
}): Promise<WhitelistStatus> {
  const sid = args.security_id;
  if (!sid || String(sid) === '0') {
    return { required: false };
  }
  try {
    const rows = await getTableRows<WhitelistRow>({
      code: 'secure.nefty',
      scope: String(sid),
      table: 'whitelists',
      limit: 1000,
    });
    const present = rows.some((r) => {
      const candidate = (r.account ?? r.name ?? '') as string;
      return candidate === args.actor;
    });
    return {
      required: true,
      allowed: present,
      reason: present
        ? undefined
        : `Ce blend (security_id=${sid}) est protégé par whitelist et ${args.actor} n'y figure pas.`,
    };
  } catch (err) {
    return {
      required: true,
      allowed: false,
      reason: `Impossible de lire la whitelist secure.nefty/${sid} : ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
