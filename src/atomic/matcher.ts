/**
 * Maps a blend's ingredients to slots the UI can render.
 *
 * Each ingredient becomes an `IngredientSlot` with a normalized kind:
 *   - TEMPLATE   : "N NFTs of template X" (most common)
 *   - SCHEMA     : "N NFTs from schema X"
 *   - ATTRIBUTE  : "N NFTs where attr in {...}"
 *   - COLLECTION , "N NFTs from collection X"
 *   - FT         : token payment ("105.00000000 UPMAX")
 *   - UNSUPPORTED, variants this app cannot satisfy (CHEST_INGREDIENT etc.)
 *
 * For NFT slots: the matcher filters the user's owned assets to the
 * ones that actually satisfy the rule (collection + template/schema +
 * attribute predicate when applicable).
 */
import type { AtomicAsset } from './assets';
import type {
  AttributeIngredient,
  CollectionIngredient,
  FtIngredient,
  IngredientVariant,
  SchemaIngredient,
  TemplateIngredient,
} from '../nefty/blend';

/**
 * One ingredient slot the user must satisfy. NFT slots (`TEMPLATE`, `SCHEMA`,
 * `ATTRIBUTE`, `COLLECTION`) need the user to pick `amount` eligible asset_ids.
 * FT slots (`FT`) are token payments, no picker, just a balance check.
 */
export type IngredientSlot = NftSlot | FtSlot | UnsupportedSlot;

interface BaseSlot {
  index: number;
  label: string;
  rawType: IngredientVariant[0];
}
export interface NftSlot extends BaseSlot {
  kind: 'TEMPLATE' | 'SCHEMA' | 'ATTRIBUTE' | 'COLLECTION';
  amount: number;
  eligible: AtomicAsset[];
  /** For TEMPLATE slots: the required template + its collection, so the UI
   *  can resolve and show the template's NAME even when the wallet holds
   *  none of it. */
  template_id?: number;
  collection_name?: string;
}
export interface FtSlot extends BaseSlot {
  kind: 'FT';
  quantity: string; // "105.00000000 UPMAX"
}
export interface UnsupportedSlot extends BaseSlot {
  kind: 'UNSUPPORTED';
}

export function buildSlots(
  ingredients: IngredientVariant[],
  ownedAssets: AtomicAsset[],
): IngredientSlot[] {
  return ingredients.map((ing, index): IngredientSlot => {
    const [type, payload] = ing;
    switch (type) {
      case 'TEMPLATE_INGREDIENT': {
        const p = payload as TemplateIngredient;
        const eligible = ownedAssets.filter(
          (a) =>
            a.collection?.collection_name === p.collection_name &&
            a.template?.template_id === String(p.template_id),
        );
        return {
          index,
          kind: 'TEMPLATE',
          amount: p.amount,
          label: `${p.amount}× template ${p.template_id} (${p.collection_name})`,
          eligible,
          rawType: type,
          template_id: Number(p.template_id),
          collection_name: p.collection_name,
        };
      }
      case 'SCHEMA_INGREDIENT': {
        const p = payload as SchemaIngredient;
        const eligible = ownedAssets.filter(
          (a) =>
            a.collection?.collection_name === p.collection_name &&
            a.schema?.schema_name === p.schema_name,
        );
        return {
          index,
          kind: 'SCHEMA',
          amount: p.amount,
          label: `${p.amount}× any NFT in schema "${p.schema_name}" (${p.collection_name})`,
          eligible,
          rawType: type,
        };
      }
      case 'ATTRIBUTE_INGREDIENT': {
        const p = payload as AttributeIngredient;
        const eligible = ownedAssets.filter((a) => {
          if (a.collection?.collection_name !== p.collection_name) return false;
          if (a.schema?.schema_name !== p.schema_name) return false;
          if (!a.data) return false;
          return p.attributes.every(({ attribute_name, allowed_values }) => {
            const v = a.data?.[attribute_name];
            return allowed_values.some((av) => String(v) === av);
          });
        });
        const filterDesc = p.attributes
          .map((a) => `${a.attribute_name}∈{${a.allowed_values.join(',')}}`)
          .join(' & ');
        return {
          index,
          kind: 'ATTRIBUTE',
          amount: p.amount,
          label: `${p.amount}× NFT (${p.collection_name}/${p.schema_name}) where ${filterDesc}`,
          eligible,
          rawType: type,
        };
      }
      case 'COLLECTION_INGREDIENT': {
        const p = payload as CollectionIngredient;
        const eligible = ownedAssets.filter(
          (a) => a.collection?.collection_name === p.collection_name,
        );
        return {
          index,
          kind: 'COLLECTION',
          amount: p.amount,
          label: `${p.amount}× any NFT from collection ${p.collection_name}`,
          eligible,
          rawType: type,
        };
      }
      case 'FT_INGREDIENT': {
        const p = payload as FtIngredient;
        return {
          index,
          kind: 'FT',
          quantity: p.quantity,
          label: `Pay ${p.quantity}`,
          rawType: type,
        };
      }
      default:
        return {
          index,
          kind: 'UNSUPPORTED',
          label: `Unsupported ingredient type: ${type}`,
          rawType: type,
        };
    }
  });
}

/**
 * Flat list of `asset_id`s for the NFT slots, in slot order. Throws if any
 * NFT slot isn't fully filled. FT slots are skipped here, token transfers
 * are built separately in execute.ts.
 */
export function flattenNftSelection(
  slots: IngredientSlot[],
  selection: Map<number, string[]>,
): string[] {
  const out: string[] = [];
  for (const slot of slots) {
    if (slot.kind === 'UNSUPPORTED') {
      throw new Error(`Slot #${slot.index} unsupported: ${slot.label}`);
    }
    if (slot.kind === 'FT') continue;
    const picked = selection.get(slot.index) ?? [];
    if (picked.length !== slot.amount) {
      throw new Error(
        `Slot #${slot.index} (${slot.label}): ${picked.length}/${slot.amount} NFTs picked.`,
      );
    }
    out.push(...picked);
  }
  return out;
}

export function ftSlots(slots: IngredientSlot[]): FtSlot[] {
  return slots.filter((s): s is FtSlot => s.kind === 'FT');
}

export function nftSlots(slots: IngredientSlot[]): NftSlot[] {
  return slots.filter(
    (s): s is NftSlot =>
      s.kind === 'TEMPLATE' || s.kind === 'SCHEMA' || s.kind === 'ATTRIBUTE' || s.kind === 'COLLECTION',
  );
}

export function totalRequiredNfts(slots: IngredientSlot[]): number {
  return nftSlots(slots).reduce((n, s) => n + s.amount, 0);
}
