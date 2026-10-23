/**
 * Maps a blend's ingredients to slots the UI can render.
 *
 * Each ingredient becomes an `IngredientSlot` with a normalized kind:
 *   - TEMPLATE   : "N NFTs of template X" (most common)
 *   - SCHEMA     : "N NFTs from schema X"
 *   - ATTRIBUTE  : "N NFTs where attr in {...}"
 *   - COLLECTION , "N NFTs from collection X"
 *   - BALANCE    : "an NFT of template X with at least N in attribute Y",
 *                  which stays in the wallet and has N taken off Y
 *   - FT         : token payment ("105.00000000 UPMAX")
 *   - UNSUPPORTED, variants this app cannot satisfy (CHEST, COOLDOWN)
 *
 * For NFT slots: the matcher filters the user's owned assets to the
 * ones that actually satisfy the rule (collection + template/schema +
 * attribute predicate when applicable).
 */
import type { AtomicAsset } from './assets';
import { attributeOf, passesAttributeList } from './attributes';
import type {
  AttributeIngredient,
  ChestIngredient,
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
  kind: 'TEMPLATE' | 'SCHEMA' | 'ATTRIBUTE' | 'COLLECTION' | 'BALANCE';
  amount: number;
  eligible: AtomicAsset[];
  /**
   * True when the NFT stays in the wallet: blend.nefty reads it from
   * `own_assets` instead of taking it in the deposit. A BALANCE slot.
   */
  keep?: boolean;
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
        // Read the way up.nefty reads it (attributes.ts). blend.nefty was
        // confirmed to combine the template and the mutable data (blend
        // 37690); which one wins when they disagree could not be tested,
        // because no NFT of an open blend has that case today.
        const eligible = ownedAssets.filter((a) => {
          if (a.collection?.collection_name !== p.collection_name) return false;
          if (a.schema?.schema_name !== p.schema_name) return false;
          return passesAttributeList(a, p.attributes);
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
      case 'BALANCE_INGREDIENT': {
        // Settled through compute_transaction on blends 23002 and 6997:
        // the NFT goes in own_assets, and the contract refuses one whose
        // attribute holds less than the cost ("Not enough balance in").
        const p = payload as ChestIngredient;
        const cost = Number(p.cost);
        const eligible = ownedAssets.filter(
          (a) => a.template?.template_id === String(p.template_id)
            && Number(attributeOf(a, p.attribute_name)) >= cost,
        );
        return {
          index,
          kind: 'BALANCE',
          amount: 1,
          keep: true,
          label: `1× NFT of template ${p.template_id} with at least ${p.cost} ${p.attribute_name} (${p.cost} is taken from it, you keep the NFT)`,
          eligible,
          rawType: type,
          template_id: Number(p.template_id),
        };
      }
      default:
        return {
          index,
          kind: 'UNSUPPORTED',
          label: type === 'COOLDOWN_INGREDIENT' ? 'A cooldown on one of your NFTs'
            : type === 'CHEST_INGREDIENT' ? 'A chest ingredient' : `Ingredient type ${type}`,
          rawType: type,
        };
    }
  });
}

/**
 * Flat list of `asset_id`s for the NFT slots that are deposited, in slot
 * order. Throws if any NFT slot isn't fully filled. FT slots are skipped
 * here, token transfers are built separately in execute.ts, and so are
 * the slots whose NFT stays in the wallet (ownNftSelection).
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
    if (!slot.keep) out.push(...picked);
  }
  return out;
}

/** The picked NFTs that stay in the wallet, for blend.nefty's `own_assets`. */
export function ownNftSelection(slots: IngredientSlot[], selection: Map<number, string[]>): string[] {
  return nftSlots(slots).filter((s) => s.keep).flatMap((s) => selection.get(s.index) ?? []);
}

export function ftSlots(slots: IngredientSlot[]): FtSlot[] {
  return slots.filter((s): s is FtSlot => s.kind === 'FT');
}

export function nftSlots(slots: IngredientSlot[]): NftSlot[] {
  return slots.filter(
    (s): s is NftSlot =>
      s.kind === 'TEMPLATE' || s.kind === 'SCHEMA' || s.kind === 'ATTRIBUTE' || s.kind === 'COLLECTION'
      || s.kind === 'BALANCE',
  );
}

export function totalRequiredNfts(slots: IngredientSlot[]): number {
  return nftSlots(slots).reduce((n, s) => n + s.amount, 0);
}
