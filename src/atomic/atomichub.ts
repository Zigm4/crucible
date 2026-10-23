/**
 * Where to find an NFT somebody does not hold: AtomicHub, the WAX
 * marketplace still running, which reads the same AtomicAssets data.
 *
 * Two links per ingredient. The explorer page says what the template,
 * schema or collection is and who holds it; the market lists what is for
 * sale, cheapest first. Both are plain links that open in a new tab, so
 * nothing is sent to AtomicHub until somebody clicks one.
 *
 * Paths checked against the live site: an unknown schema answers 404, a
 * real one opens its page, and the market applies every filter given.
 */
const SITE = 'https://wax.atomichub.io';
const CHAIN = 'wax-mainnet';

/** What an ingredient asks for, as precisely as it says. */
export interface MarketRef {
  collection: string;
  template_id?: number | string;
  schema?: string;
}

const part = (s: string | number) => encodeURIComponent(String(s));

/** The explorer page: the template, else the schema, else the collection. */
export function explorerUrl(ref: MarketRef): string {
  if (ref.template_id !== undefined && ref.template_id !== '') {
    return `${SITE}/explorer/template/${CHAIN}/${part(ref.collection)}/${part(ref.template_id)}`;
  }
  if (ref.schema) return `${SITE}/explorer/schema/${CHAIN}/${part(ref.collection)}/${part(ref.schema)}`;
  return `${SITE}/explorer/collection/${CHAIN}/${part(ref.collection)}`;
}

/** The market, filtered the same way and cheapest first. */
export function marketUrl(ref: MarketRef): string {
  const q = new URLSearchParams({ collection_name: ref.collection });
  if (ref.template_id !== undefined && ref.template_id !== '') q.set('template_id', String(ref.template_id));
  else if (ref.schema) q.set('schema_name', ref.schema);
  q.set('order', 'asc');
  q.set('sort', 'price');
  return `${SITE}/market?${q.toString()}`;
}
