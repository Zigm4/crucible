import { withFailover } from '../chain/rpc';

/**
 * Minimal subset of the EOSIO ABI shape we care about.
 * We only read it to verify that the contract still exposes the actions /
 * tables / structs we depend on. If a future redeploy renames anything,
 * the app fails fast at startup instead of silently building broken
 * transactions.
 */
export interface ContractAbi {
  version: string;
  types: { new_type_name: string; type: string }[];
  structs: { name: string; base: string; fields: { name: string; type: string }[] }[];
  actions: { name: string; type: string; ricardian_contract?: string }[];
  tables: { name: string; index_type?: string; key_names?: string[]; type: string }[];
  variants?: { name: string; types: string[] }[];
}

export interface BlendContractShape {
  actions: {
    announcedepo: { fields: Record<string, string> };
    nosecfuse: { fields: Record<string, string> };
  };
  tables: {
    blends: { struct: string };
  };
}

let cachedShape: BlendContractShape | undefined;

export async function loadBlendContractShape(): Promise<BlendContractShape> {
  if (cachedShape) return cachedShape;

  const abi = await withFailover(async (client) => {
    const res = await client.v1.chain.get_abi('blend.nefty');
    if (!res.abi) {
      throw new Error('blend.nefty has no ABI deployed (account empty?)');
    }
    return res.abi as ContractAbi;
  });

  const findStruct = (name: string) => {
    const s = abi.structs.find((x) => x.name === name);
    if (!s) throw new Error(`blend.nefty ABI missing struct '${name}'`);
    return s;
  };
  const findAction = (name: string) => {
    const a = abi.actions.find((x) => x.name === name);
    if (!a) {
      throw new Error(
        `blend.nefty ABI no longer exposes action '${name}' — contract may have been upgraded.`,
      );
    }
    return a;
  };
  const findTable = (name: string) => {
    const t = abi.tables.find((x) => x.name === name);
    if (!t) {
      throw new Error(
        `blend.nefty ABI no longer exposes table '${name}'. Available: ${abi.tables.map((t) => t.name).join(', ')}`,
      );
    }
    return t;
  };

  const actionFields = (action_name: string) => {
    const action = findAction(action_name);
    const struct = findStruct(action.type);
    return Object.fromEntries(struct.fields.map((f) => [f.name, f.type]));
  };

  cachedShape = {
    actions: {
      announcedepo: { fields: actionFields('announcedepo') },
      nosecfuse: { fields: actionFields('nosecfuse') },
    },
    tables: {
      blends: { struct: findTable('blends').type },
    },
  };

  // sanity: required fields exist
  const a = cachedShape.actions.announcedepo.fields;
  if (!('owner' in a) || !('count' in a)) {
    throw new Error("Unexpected announcedepo signature: " + JSON.stringify(a));
  }
  const n = cachedShape.actions.nosecfuse.fields;
  for (const f of ['blend_id', 'claimer', 'transferred_assets', 'own_assets']) {
    if (!(f in n)) {
      throw new Error(`Unexpected nosecfuse signature, missing '${f}': ${JSON.stringify(n)}`);
    }
  }

  return cachedShape;
}
