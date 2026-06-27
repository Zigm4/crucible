/**
 * Collection-author action: create a NeftyBlocks drop (`neftyblocksd::createdrop`).
 *
 * Like the blend/secure admin actions, this carries an `authorized_account`
 * that the contract checks against the collection's `authorized_accounts`
 * list - the UI only surfaces it when the connected wallet is detected as a
 * manager, but the chain is the real guard.
 *
 * The struct is taken verbatim from the live `neftyblocksd` ABI:
 *   authorized_account, collection_name, assets_to_mint (ASSET_TO_MINT[]),
 *   listing_price (asset), alternative_prices (asset[]), settlement_symbol
 *   (symbol), price_recipient (name), auth_required (bool), is_hidden (bool),
 *   max_claimable (uint64), account_limit (uint64), account_limit_cooldown
 *   (uint32), start_time (uint32), end_time (uint32), display_data (string),
 *   distribution_id (uint64), allow_credit_card_payments (bool),
 *   referral_fee (float64), referral_whitelist_id (uint64).
 *
 * Drops mint from EXISTING templates: assets_to_mint is a flat list where N
 * copies of a template appear as N repeated entries. This module only builds
 * a drop from templates that already exist on the collection; creating new
 * templates/schemas is a separate (riskier) flow not handled here.
 */
import type { BuiltAction } from './execute';

const DROPS = 'neftyblocksd';

export interface AssetToMint {
  template_id: number;
  /** Fungible tokens "backed" into each mint. Empty for a standard drop. */
  tokens_to_back: string[];
  /** Draw from a pre-minted pool instead of minting fresh. False = mint. */
  use_pool: boolean;
}

export interface CreateDropArgs {
  authorized_account: string;
  collection_name: string;
  assets_to_mint: AssetToMint[];
  /** Asset string, e.g. "1.00000000 WAX". Use FREE_LISTING_PRICE for free. */
  listing_price: string;
  alternative_prices: string[];
  /** e.g. "8,WAX" (or FREE_SETTLEMENT_SYMBOL "0,NULL" for free). */
  settlement_symbol: string;
  price_recipient: string;
  auth_required: boolean;
  is_hidden: boolean;
  max_claimable: number; // 0 = unlimited
  account_limit: number; // 0 = no per-account cap
  account_limit_cooldown: number; // seconds
  start_time: number; // unix seconds, 0 = starts immediately
  end_time: number; // unix seconds, 0 = never ends
  display_data: string; // JSON: {name, description, image}
  distribution_id: number; // 0 = none
  allow_credit_card_payments: boolean;
  referral_fee: number; // 0 = none
  referral_whitelist_id: number; // 0 = none
}

function auth(actor: string) {
  return [{ actor, permission: 'active' }];
}

export function buildCreateDrop(a: CreateDropArgs): BuiltAction {
  return {
    account: DROPS,
    name: 'createdrop',
    authorization: auth(a.authorized_account),
    // Field names (not order) are what the ABI serializer keys on.
    data: {
      authorized_account: a.authorized_account,
      collection_name: a.collection_name,
      assets_to_mint: a.assets_to_mint,
      listing_price: a.listing_price,
      alternative_prices: a.alternative_prices,
      settlement_symbol: a.settlement_symbol,
      price_recipient: a.price_recipient,
      auth_required: a.auth_required,
      is_hidden: a.is_hidden,
      max_claimable: a.max_claimable,
      account_limit: a.account_limit,
      account_limit_cooldown: a.account_limit_cooldown,
      start_time: a.start_time,
      end_time: a.end_time,
      display_data: a.display_data,
      distribution_id: a.distribution_id,
      allow_credit_card_payments: a.allow_credit_card_payments,
      referral_fee: a.referral_fee,
      referral_whitelist_id: a.referral_whitelist_id,
    },
  };
}

// NeftyBlocks encodes a free drop as the "0 NULL" asset / "0,NULL" symbol.
export const FREE_LISTING_PRICE = '0 NULL';
export const FREE_SETTLEMENT_SYMBOL = '0,NULL';

/** Builds a priced listing from an amount + token code + decimals. */
export function formatListing(
  amount: number,
  tokenCode: string,
  decimals: number,
): { listing_price: string; settlement_symbol: string } {
  const sym = tokenCode.trim().toUpperCase();
  const dec = Math.max(0, Math.floor(decimals));
  return {
    listing_price: `${amount.toFixed(dec)} ${sym}`,
    settlement_symbol: `${dec},${sym}`,
  };
}

/** Builds the display_data JSON the contract stores (name/description/image). */
export function buildDropDisplayData(name: string, description: string, image: string): string {
  const dd: Record<string, string> = {};
  if (name.trim()) dd.name = name.trim();
  if (description.trim()) dd.description = description.trim();
  if (image.trim()) dd.image = image.trim();
  return JSON.stringify(dd);
}

export interface TemplateEntry {
  template_id: number;
  quantity: number;
}

/**
 * Parses a free-form "templates to mint" string. Entries are separated by
 * comma or newline; each is a template_id with an optional quantity via
 * "xN", "*N" or ":N" (default 1). Invalid tokens are skipped.
 */
export function parseTemplateEntries(input: string): TemplateEntry[] {
  const out: TemplateEntry[] = [];
  for (const raw of input.split(/[\n,]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)\s*(?:[x*:]\s*(\d+))?$/i);
    if (!m) continue;
    const template_id = Number(m[1]);
    if (!Number.isFinite(template_id) || template_id <= 0) continue;
    const quantity = m[2] ? Math.max(1, Number(m[2])) : 1;
    out.push({ template_id, quantity });
  }
  return out;
}

/** Flattens template entries into the repeated assets_to_mint list. */
export function entriesToAssets(entries: TemplateEntry[]): AssetToMint[] {
  const assets: AssetToMint[] = [];
  for (const e of entries) {
    for (let i = 0; i < e.quantity; i++) {
      assets.push({ template_id: e.template_id, tokens_to_back: [], use_pool: false });
    }
  }
  return assets;
}

/** Total number of NFTs a set of entries will mint. */
export function totalMints(entries: TemplateEntry[]): number {
  return entries.reduce((n, e) => n + e.quantity, 0);
}
