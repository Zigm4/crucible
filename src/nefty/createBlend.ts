/**
 * Builds the `blend.nefty::createblend` action (collection authors).
 *
 * This is the author-side counterpart to execute.ts: instead of running
 * a recipe, it registers one. Same spirit as createDrop.ts, but the
 * payload is a different order of complexity, because a blend is a tree
 * rather than a list:
 *
 *   createblend(authorized_account, collection_name,
 *               ingredients[],     <- 8-way variant, what gets consumed
 *               rolls[],           <- each roll: weighted outcomes,
 *                                     each outcome: a list of results
 *               start_time, end_time, max_uses, display_data,
 *               security_id, is_hidden, category,
 *               account_limit, account_limit_cooldown)
 *
 * Two encodings are easy to get wrong and are the whole reason this
 * module exists rather than inlining the object in the UI:
 *
 *   - EOSIO variants serialise as `[tag, payload]` tuples, so an
 *     ingredient is `['TEMPLATE_INGREDIENT', {...}]` and never a
 *     flattened `{type, ...}` object (which is what the INDEXER
 *     returns when reading blends back, an easy trap).
 *   - every ingredient carries an `effect` saying what the contract
 *     does with it. `['TYPED_EFFECT', {type: 0}]` burns;
 *     `['TRANSFER_EFFECT', {to}]` hands it to an account. NFTs are
 *     usually burned but NOT always (18 of 362 across recent real
 *     creations go to a vault), and token costs are always transferred.
 *     Assuming "NFTs burn" is a silent data-loss bug, so the caller
 *     chooses - see NftDisposal.
 *
 * Odds are integers summed into `total_odds` per roll. The contract
 * does not normalise them: `[50, 50]` with total 100 and `[1, 1]` with
 * total 2 are both valid and mean the same thing, but a `total_odds`
 * that does not equal the sum silently changes the probabilities, so
 * the builder computes it rather than trusting a caller.
 *
 * Verified byte-for-byte against five real on-chain creations spanning
 * five collections and every ingredient kind: scripts/verify-createblend.mjs
 */

import type { Session } from '@wharfkit/session';

import type { BuiltAction } from './execute';

export const BLEND_CONTRACT = 'blend.nefty';

/** What the contract does with a consumed ingredient. */
export type IngredientEffect =
  /** Burn it. `type: 0` is what every observed NFT ingredient uses. */
  | { kind: 'burn' }
  /** Send it to an account (used for token costs). */
  | { kind: 'transfer'; to: string };

/**
 * Where a consumed NFT ends up. Burning is the common case (343 of the
 * 362 NFT ingredients across the 250 most recent real creations), but a
 * meaningful minority route them to a vault account instead - e.g.
 * streamingart sends its inputs to `streamvaults`. Getting this wrong
 * does not fail loudly: it silently destroys NFTs an author meant to
 * keep, so it is an explicit choice rather than an assumption.
 */
export interface NftDisposal {
  /** When set, the NFTs are transferred here instead of burned. */
  transfer_to?: string;
}

/** One thing the blender must provide. */
export type NewIngredient =
  | ({ kind: 'template'; template_id: number; collection_name: string; amount: number } & NftDisposal)
  | ({ kind: 'schema'; collection_name: string; schema_name: string; amount: number; display_data?: string } & NftDisposal)
  | ({
      kind: 'attribute';
      collection_name: string;
      schema_name: string;
      amount: number;
      display_data?: string;
      attributes: { attribute_name: string; allowed_values: string[] }[];
    } & NftDisposal)
  | ({ kind: 'collection'; collection_name: string; amount: number } & NftDisposal)
  /**
   * A time gate rather than a cost: the contract refuses the blend until
   * `wait_time` has elapsed since the NFT's tracked attribute. Only 2 of
   * ~24,800 real ingredients use it, but modelling it keeps the builder
   * able to reproduce any recipe on chain.
   */
  | {
      kind: 'cooldown';
      schema_name: string;
      template_id: number;
      attribute_name: string;
      wait_time: number;
      requirements: { attribute_name: string; allowed_values: string[] }[];
      display_data?: string;
    }
  /**
   * Token cost, e.g. "10.0000 TLM". Every real trace routes the payment
   * to an account (358/358), so `to` is required in practice.
   */
  | { kind: 'ft'; quantity: string; to?: string };

/**
 * What a drawn outcome hands over. A blend is not limited to minting an
 * NFT: across the 10,000 most recent real creations the contract also
 * pays out tokens (801 results) and draws pre-minted NFTs from a pool
 * (1,076). Modelling only the first would build silently different
 * recipes for ~1 in 9 blends.
 */
export type NewResult =
  /** Mint a new NFT from a template. */
  | { kind: 'nft'; template_id: number }
  /** Pay tokens, e.g. "0.75000000 WAX" on eosio.token. */
  | { kind: 'ft'; quantity: string; contract: string }
  /** Hand over a pre-minted NFT from a named pool (see nefty/pools.ts). */
  | { kind: 'pool'; pool_name: string; display_data?: string };

/** One possible payout of a roll, with its integer weight. */
export interface NewOutcome {
  odds: number;
  /**
   * What this branch gives. MAY be empty: a roll can carry a blank that
   * hands over nothing, which is how authors build a "you got unlucky"
   * branch. waxlandianft's 51-outcome blend opens with exactly that -
   * odds 2000 out of 10000, no results.
   */
  results: NewResult[];
}

/** A blend mints one result per roll. Most recipes have exactly one. */
export interface NewRoll {
  outcomes: NewOutcome[];
}

export interface CreateBlendArgs {
  authorized_account: string;
  collection_name: string;
  ingredients: NewIngredient[];
  rolls: NewRoll[];
  /** Unix SECONDS. 0 = starts immediately. */
  start_time?: number;
  /** Unix SECONDS. 0 = never ends. */
  end_time?: number;
  /** 0 = unlimited. */
  max_uses?: number;
  /** JSON blob: {"name":..., "description":..., "image":...}. */
  display_data?: string;
  /** secure.nefty whitelist id. 0 = open to everyone. */
  security_id?: string | number;
  is_hidden?: boolean;
  category?: string;
  /** Per-account cap. 0 = unlimited. */
  account_limit?: number;
  /** Seconds before the per-account counter resets. 0 = never. */
  account_limit_cooldown?: number;
}

// ─── encoding ───────────────────────────────────────────────────────────

type Variant = [string, Record<string, unknown>];

function encodeEffect(e: IngredientEffect): Variant {
  return e.kind === 'transfer'
    ? ['TRANSFER_EFFECT', { to: e.to }]
    : ['TYPED_EFFECT', { type: 0 }];
}

/** Burn. `type: 0` is what every burning trace carries. */
const BURN: Variant = ['TYPED_EFFECT', { type: 0 }];

/** Burn unless the author named a destination for the NFTs. */
function nftEffect(d: NftDisposal): Variant {
  return d.transfer_to ? ['TRANSFER_EFFECT', { to: d.transfer_to }] : BURN;
}

export function encodeIngredient(ing: NewIngredient): Variant {
  switch (ing.kind) {
    case 'template':
      return ['TEMPLATE_INGREDIENT', {
        template_id: ing.template_id,
        collection_name: ing.collection_name,
        amount: ing.amount,
        effect: nftEffect(ing),
      }];
    case 'schema':
      return ['SCHEMA_INGREDIENT', {
        collection_name: ing.collection_name,
        schema_name: ing.schema_name,
        display_data: ing.display_data ?? '',
        amount: ing.amount,
        effect: nftEffect(ing),
      }];
    case 'attribute':
      return ['ATTRIBUTE_INGREDIENT', {
        collection_name: ing.collection_name,
        schema_name: ing.schema_name,
        display_data: ing.display_data ?? '',
        attributes: ing.attributes,
        amount: ing.amount,
        effect: nftEffect(ing),
      }];
    case 'collection':
      return ['COLLECTION_INGREDIENT', {
        collection_name: ing.collection_name,
        amount: ing.amount,
        effect: nftEffect(ing),
      }];
    case 'cooldown':
      return ['COOLDOWN_INGREDIENT', {
        schema_name: ing.schema_name,
        template_id: ing.template_id,
        attribute_name: ing.attribute_name,
        wait_time: ing.wait_time,
        requirements: ing.requirements,
        display_data: ing.display_data ?? '',
      }];
    case 'ft':
      // A token cost with no destination would be burned; every real
      // trace names a receiver, and validateNewBlend() insists on one.
      return ['FT_INGREDIENT', {
        quantity: ing.quantity,
        effect: encodeEffect(ing.to ? { kind: 'transfer', to: ing.to } : { kind: 'burn' }),
      }];
  }
}

/** Result variant encoding. */
export function encodeResult(r: NewResult): Variant {
  switch (r.kind) {
    case 'nft':
      return ['ON_DEMAND_NFT_RESULT', { template_id: r.template_id }];
    case 'ft':
      return ['FT_RESULT', { amount: { quantity: r.quantity, contract: r.contract } }];
    case 'pool':
      return ['POOL_NFT_RESULT', { pool_name: r.pool_name, display_data: r.display_data ?? '' }];
  }
}

/**
 * Encodes a roll, deriving `total_odds` from the outcomes.
 *
 * The contract divides each outcome's odds by total_odds, so a mismatch
 * does not error - it silently skews the draw, or makes part of the
 * roll unreachable. Computing it here removes that whole class of bug.
 */
export function encodeRoll(roll: NewRoll): Record<string, unknown> {
  return {
    outcomes: roll.outcomes.map((o) => ({
      odds: o.odds,
      results: o.results.map(encodeResult),
    })),
    total_odds: roll.outcomes.reduce((n, o) => n + o.odds, 0),
  };
}

// ─── validation ─────────────────────────────────────────────────────────

/**
 * Everything that would make the contract reject the action, or - worse -
 * accept a recipe that behaves differently than the author intended.
 * Returned as messages so the UI can block signing and explain why.
 */
export function validateNewBlend(args: CreateBlendArgs): string[] {
  const errs: string[] = [];
  if (!args.authorized_account) errs.push('No authorized account: connect the wallet that manages this collection.');
  if (!args.collection_name) errs.push('Collection name is required.');
  if (args.ingredients.length === 0) errs.push('A blend needs at least one ingredient.');
  if (args.rolls.length === 0) errs.push('A blend needs at least one roll (what it mints).');

  args.ingredients.forEach((ing, i) => {
    if (ing.kind === 'ft') {
      // "10.0000 TLM": the precision must match the token's own, and the
      // contract rejects anything it cannot parse as an asset.
      if (!/^\d+\.\d+ [A-Z]{1,7}$/.test(ing.quantity)) {
        errs.push(`Ingredient #${i + 1}: "${ing.quantity}" is not a valid quantity (expected e.g. "10.0000 TLM").`);
      }
      if (!ing.to) {
        errs.push(`Ingredient #${i + 1}: a token cost needs a receiving account, otherwise the tokens are burned.`);
      }
    } else if (ing.kind !== 'cooldown' && (!Number.isFinite(ing.amount) || ing.amount < 1)) {
      errs.push(`Ingredient #${i + 1}: amount must be at least 1.`);
    }
    if (ing.kind === 'template' && !(ing.template_id > 0)) {
      errs.push(`Ingredient #${i + 1}: template id is required.`);
    }
    if (ing.kind === 'attribute' && ing.attributes.length === 0) {
      errs.push(`Ingredient #${i + 1}: an attribute ingredient needs at least one attribute filter.`);
    }
  });

  args.rolls.forEach((roll, r) => {
    if (roll.outcomes.length === 0) {
      errs.push(`Roll #${r}: needs at least one outcome.`);
      return;
    }
    roll.outcomes.forEach((o, oi) => {
      if (!Number.isFinite(o.odds) || o.odds < 1) {
        errs.push(`Roll #${r}, outcome #${oi + 1}: odds must be a positive whole number.`);
      }
      // An empty outcome is legal (it hands over nothing), so only the
      // results that ARE listed have to be well formed.
      o.results.forEach((res, ri) => {
        const at = `Roll #${r}, outcome #${oi + 1}, result #${ri + 1}`;
        if (res.kind === 'nft' && !(res.template_id > 0)) errs.push(`${at}: template id required.`);
        if (res.kind === 'ft') {
          if (!/^\d+\.\d+ [A-Z]{1,7}$/.test(res.quantity)) errs.push(`${at}: "${res.quantity}" is not a valid quantity.`);
          if (!res.contract) errs.push(`${at}: token contract required.`);
        }
        if (res.kind === 'pool' && !res.pool_name) errs.push(`${at}: pool name required.`);
      });
    });
  });

  const start = args.start_time ?? 0;
  const end = args.end_time ?? 0;
  if (end > 0 && start > 0 && end <= start) {
    errs.push('End time must be after start time.');
  }
  if (args.display_data) {
    try { JSON.parse(args.display_data); }
    catch { errs.push('Display data must be valid JSON.'); }
  }
  return errs;
}

// ─── text form ──────────────────────────────────────────────────────────
//
// The form takes ingredients and outcomes as one-per-line text rather
// than a widget tree. Same choice the drop creator makes for its
// "templates to mint" field, and it keeps a recipe copy-pasteable
// between collections, which is how authors actually work.


/**
 * Strips a trailing `# comment`, but never inside a {...} blob: pool
 * display_data and ingredient display_data are JSON, and real names
 * contain "#" ("Mint #1 Rare Riley", "VegasKitties#3"). Cutting there
 * silently truncated the recipe.
 */
function stripComment(line: string): string {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '#' && depth === 0) return line.slice(0, i);
  }
  return line;
}

export interface ParseResult<T> {
  items: T[];
  /** Per-line problems, already worded for display. */
  errors: string[];
}

/**
 * Parses the ingredients box. One per line, blank lines and `#`
 * comments ignored:
 *
 *   template 877088 x5                   burn 5 NFTs of template 877088
 *   template 877088 x5 -> vault.wam      send them to vault.wam instead
 *   template alien.worlds:741859 x1      an NFT from ANOTHER collection
 *   schema up.tools x3                   any 3 NFTs of that schema
 *   schema othercoll:gear x3             ...from another collection
 *   collection x2                        any 2 NFTs of this collection
 *   collection alien.worlds x2           ...of another one
 *   token 10.0000 TLM -> cairc.wam       token cost, paid to that account
 *
 * The `collection:` prefix matters: a blend may require NFTs it does
 * not own the collection of. streamingart's real recipes mix their own
 * templates with an `alien.worlds` one, and defaulting everything to
 * the blend's collection would silently build the wrong recipe.
 */
export function parseIngredientLines(text: string, collection: string): ParseResult<NewIngredient> {
  const items: NewIngredient[] = [];
  const errors: string[] = [];

  text.split('\n').forEach((raw, idx) => {
    let line = stripComment(raw).trim();
    if (!line) return;
    const where = `Line ${idx + 1}`;

    // A trailing balanced {...} is the ingredient's display_data. Pulled
    // off first because everything else is whitespace-delimited and the
    // blob can contain spaces, "=", "|" and the rest.
    let display_data: string | undefined;
    if (line.endsWith('}')) {
      let depth = 0;
      for (let i = line.length - 1; i >= 0; i--) {
        if (line[i] === '}') depth += 1;
        else if (line[i] === '{') {
          depth -= 1;
          if (depth === 0) {
            display_data = line.slice(i).trim();
            line = line.slice(0, i).trim();
            break;
          }
        }
      }
    }

    // Optional "-> account" decides burn vs transfer. The account is a
    // single token, NOT "everything after the arrow": an attribute
    // ingredient can be written "… -> vault.wam where rarity = Rare",
    // and swallowing the filter into the account name silently broke
    // every recipe that combines the two.
    const arrow = line.split('->');
    if (arrow.length > 2) {
      errors.push(`${where}: only one "->" is allowed.`);
      return;
    }
    let body = arrow[0].trim();
    let to: string | undefined;
    if (arrow.length > 1) {
      const rest = arrow[1].trim();
      const sp = rest.search(/\s/);
      to = (sp < 0 ? rest : rest.slice(0, sp)).trim();
      // Whatever followed the account belongs to the ingredient body.
      if (sp >= 0) body = `${body} ${rest.slice(sp).trim()}`.trim();
    }
    if (to !== undefined && !/^[a-z1-5.]{1,12}$/.test(to)) {
      errors.push(`${where}: "${to}" is not a valid WAX account.`);
      return;
    }

    // The "xN" multiplier is a standalone token and does NOT have to be
    // last: "attribute up.gear x2 where ..." puts it mid-line. Anchoring
    // it to the end silently parsed those as amount 1.
    const amountMatch = body.match(/(?:^|\s)x\s*(\d+)(?=\s|$)/i);
    const amount = amountMatch ? Number(amountMatch[1]) : 1;
    const at = amountMatch?.index ?? -1;
    const head = at >= 0 && amountMatch
      ? (body.slice(0, at) + ' ' + body.slice(at + amountMatch[0].length)).replace(/\s+/g, ' ').trim()
      : body;
    const [kw, ...rest] = head.split(/\s+/);
    const kind = (kw || '').toLowerCase();

    // "<collection>:<value>" overrides the blend's own collection.
    const split = (v: string): { coll: string; value: string } => {
      const i = (v ?? '').indexOf(':');
      return i < 0
        ? { coll: collection, value: v ?? '' }
        : { coll: v.slice(0, i).trim(), value: v.slice(i + 1).trim() };
    };

    if (kind === 'template') {
      const { coll, value } = split(rest[0]);
      const tid = Number(value);
      if (!Number.isFinite(tid) || tid <= 0) {
        errors.push(`${where}: "${rest[0] ?? ''}" is not a template id.`);
        return;
      }
      items.push({ kind: 'template', template_id: tid, collection_name: coll, amount, transfer_to: to });
    } else if (kind === 'schema') {
      const { coll, value } = split(rest[0]);
      if (!value) { errors.push(`${where}: schema name missing.`); return; }
      items.push({ kind: 'schema', collection_name: coll, schema_name: value, amount, display_data, transfer_to: to });
    } else if (kind === 'collection') {
      items.push({ kind: 'collection', collection_name: rest[0] || collection, amount, transfer_to: to });
    } else if (kind === 'attribute') {
      // attribute [coll:]<schema> xN where <attr> = <v1> | <v2> | ...
      // Values may contain commas and colons, so "|" separates them and
      // the first "=" ends the attribute name.
      const m = head.match(/^attribute\s+(\S+)\s+where\s+(.+)$/i);
      if (!m) {
        errors.push(`${where}: expected "attribute <schema> xN where <attr> = <value> | <value>".`);
        return;
      }
      const { coll, value: schema } = split(m[1]);
      // "attr = a | b ; other = c" - ";" separates filters, all required.
      const attributes: { attribute_name: string; allowed_values: string[] }[] = [];
      let bad = false;
      for (const clause of m[2].split(';')) {
        const c = clause.trim();
        if (!c) continue;
        const eq = c.indexOf('=');
        if (eq < 0) { errors.push(`${where}: missing "=" in "${c}".`); bad = true; break; }
        const attribute_name = c.slice(0, eq).trim();
        const allowed_values = c.slice(eq + 1).split('|').map((v) => v.trim()).filter(Boolean);
        if (!attribute_name) { errors.push(`${where}: attribute name missing.`); bad = true; break; }
        if (allowed_values.length === 0) { errors.push(`${where}: list at least one allowed value.`); bad = true; break; }
        attributes.push({ attribute_name, allowed_values });
      }
      if (bad) return;
      if (attributes.length === 0) { errors.push(`${where}: no attribute filter.`); return; }
      items.push({
        kind: 'attribute',
        collection_name: coll,
        schema_name: schema,
        amount,
        attributes,
        display_data,
        transfer_to: to,
      });
    } else if (kind === 'token') {
      // "token 10.0000 TLM": the rest, minus any trailing amount marker.
      const quantity = rest.join(' ').trim();
      if (!quantity) { errors.push(`${where}: token quantity missing.`); return; }
      items.push({ kind: 'ft', quantity, to });
    } else {
      errors.push(`${where}: unknown ingredient "${kw}". Use template / schema / collection / attribute / token.`);
    }
  });

  return { items, errors };
}

/**
 * Parses the outcomes box. One per line:
 *
 *   907173                      mint template 907173
 *   907173 @50                  ...with weight 50
 *   907173+906880 @3            one branch handing over BOTH
 *   nothing @20                 a blank: this branch gives nothing
 *   token 1.00000000 WAX @5     pay tokens (eosio.token unless stated)
 *   token 5.0000 TLM from alien.worlds @2
 *   pool eternalblaze @1        hand over an NFT from that pool
 *
 * Weights are relative: the builder sums them into total_odds, so
 * `@50/@50` and `@1/@1` both mean 50/50.
 */

/**
 * Splits on `sep` but never inside a {...} blob, so a pool result's
 * display_data JSON (which contains commas, spaces, colons and can
 * contain the separators themselves) survives intact.
 */
function splitOutsideBraces(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseOutcomeLines(text: string): ParseResult<NewOutcome> {
  const items: NewOutcome[] = [];
  const errors: string[] = [];

  text.split('\n').forEach((raw, idx) => {
    const line = stripComment(raw).trim();
    if (!line) return;
    const where = `Line ${idx + 1}`;

    // Odds are the trailing "@<n>". Matched at the end rather than by
    // splitting, because a pool result's display_data may contain "@".
    const oddsMatch = line.match(/@\s*(\d+)\s*$/);
    const odds = oddsMatch ? Number(oddsMatch[1]) : 1;
    if (!Number.isFinite(odds) || odds < 1 || !Number.isInteger(odds)) {
      errors.push(`${where}: odds must be a whole number of at least 1.`);
      return;
    }
    const head = (oddsMatch ? line.slice(0, oddsMatch.index) : line).trim();
    // An explicit blank branch: hands over nothing when drawn.
    if (['nothing', 'none', 'empty', '-'].includes(head.toLowerCase())) {
      items.push({ odds, results: [] });
      return;
    }

    const results: NewResult[] = [];
    let bad = false;
    for (const partRaw of splitOutsideBraces(head, '+')) {
      const part = partRaw.trim();
      if (!part) continue;
      const lower = part.toLowerCase();
      if (lower.startsWith('token ')) {
        // token <quantity> [from <contract>]
        const m = part.slice(6).match(/^(.*?)(?:\s+from\s+(\S+))?$/i);
        const quantity = (m?.[1] ?? '').trim();
        if (!quantity) { errors.push(`${where}: token payout needs a quantity.`); bad = true; break; }
        results.push({ kind: 'ft', quantity, contract: (m?.[2] ?? 'eosio.token').trim() });
      } else if (lower.startsWith('pool ')) {
        // pool <name> [<display json>]
        const rest2 = part.slice(5).trim();
        const sp = rest2.indexOf(' ');
        const pool_name = sp < 0 ? rest2 : rest2.slice(0, sp).trim();
        const display_data = sp < 0 ? '' : rest2.slice(sp + 1).trim();
        if (!pool_name) { errors.push(`${where}: pool name missing.`); bad = true; break; }
        results.push({ kind: 'pool', pool_name, display_data });
      } else {
        const tid = Number(part);
        if (!Number.isFinite(tid) || tid <= 0) {
          errors.push(`${where}: "${part}" is not a template id, "token …", "pool …" or "nothing".`);
          bad = true;
          break;
        }
        results.push({ kind: 'nft', template_id: tid });
      }
    }
    if (bad) return;
    if (results.length === 0) { errors.push(`${where}: nothing to hand over.`); return; }
    items.push({ odds, results });
  });

  return { items, errors };
}

/** Human summary of the draw, so an author can sanity-check the odds. */
export function describeOdds(outcomes: NewOutcome[]): string[] {
  const total = outcomes.reduce((n, o) => n + o.odds, 0);
  if (total <= 0) return [];
  const label = (r: NewResult) =>
    r.kind === 'nft' ? `template ${r.template_id}`
      : r.kind === 'ft' ? r.quantity
        : `pool ${r.pool_name}`;
  return outcomes.map(
    (o) =>
      `${o.results.length ? o.results.map(label).join(' + ') : 'nothing'} — ${((o.odds / total) * 100).toFixed(2)}% (${o.odds}/${total})`,
  );
}

// ─── action ─────────────────────────────────────────────────────────────

export function buildCreateBlendAction(args: CreateBlendArgs): BuiltAction {
  return {
    account: BLEND_CONTRACT,
    name: 'createblend',
    authorization: [{ actor: args.authorized_account, permission: 'active' }],
    data: {
      authorized_account: args.authorized_account,
      collection_name: args.collection_name,
      ingredients: args.ingredients.map(encodeIngredient),
      rolls: args.rolls.map(encodeRoll),
      start_time: args.start_time ?? 0,
      end_time: args.end_time ?? 0,
      max_uses: args.max_uses ?? 0,
      display_data: args.display_data ?? '',
      security_id: String(args.security_id ?? 0),
      is_hidden: args.is_hidden ?? false,
      category: args.category ?? '',
      account_limit: String(args.account_limit ?? 0),
      account_limit_cooldown: args.account_limit_cooldown ?? 0,
    },
  };
}

/** Sign-and-broadcast wrapper. */
export async function executeCreateBlend(session: Session, args: Omit<CreateBlendArgs, 'authorized_account'>) {
  const action = buildCreateBlendAction({
    ...args,
    authorized_account: String(session.actor),
  });
  return session.transact({ actions: [action] });
}
