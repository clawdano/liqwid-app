// ═══════════════════════════════════════════════════════════════════
// Blockfrost API Wrapper with Caching
// ═══════════════════════════════════════════════════════════════════

const API_KEY = "mainnetmYbTW9Ne1hmN5am2IohNI96Db4IZWWdw";
const BASE = "https://cardano-mainnet.blockfrost.io/api/v0";

// Simple TTL cache
const cache = new Map();
const CACHE_TTL = 30_000; // 30 seconds

function cacheKey(path) { return path; }

function getCached(path) {
  const entry = cache.get(cacheKey(path));
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data;
  return null;
}

function setCache(path, data) {
  cache.set(cacheKey(path), { data, ts: Date.now() });
}

export function clearCache() {
  cache.clear();
}

async function bf(path, opts = {}) {
  const cached = getCached(path);
  if (cached && !opts.noCache) return cached;

  const res = await fetch(`${BASE}${path}`, {
    headers: { "project_id": API_KEY },
  });

  if (res.status === 429) {
    // Rate limited — wait and retry once
    await new Promise(r => setTimeout(r, 1000));
    return bf(path, { ...opts, noCache: true });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Blockfrost ${res.status}: ${path} — ${body}`);
  }

  const data = await res.json();
  setCache(path, data);
  return data;
}

/**
 * Find UTxO holding a given token (policyId with empty token name).
 * Returns the first UTxO with a datum, with plutusData resolved to parsed JSON.
 */
export async function findUtxoByToken(policyId) {
  const utxo = await findUtxoByTokenRaw(policyId);
  if (utxo.output.datumHash) {
    utxo.output.plutusData = await fetchDatumJson(utxo.output.datumHash);
  }
  return utxo;
}

/**
 * Internal: find raw UTxO by token without resolving datum.
 */
async function findUtxoByTokenRaw(policyId) {
  const asset = policyId;
  const addresses = await bf(`/assets/${asset}/addresses`);

  if (!addresses || addresses.length === 0) {
    throw new Error(`No addresses found for token ${policyId.slice(0, 16)}...`);
  }

  for (const addrEntry of addresses) {
    const utxos = await bf(`/addresses/${addrEntry.address}/utxos/${asset}`);
    if (utxos && utxos.length > 0) {
      for (const u of utxos) {
        if (u.data_hash || u.inline_datum) {
          return blockfrostUtxoToMesh(u, addrEntry.address);
        }
      }
    }
  }

  throw new Error(`No UTxO with datum found for token ${policyId.slice(0, 16)}...`);
}

/**
 * Find all Action UTxOs for a market (for random selection / contention avoidance).
 * Resolves datums to parsed JSON.
 */
export async function findAllActionUtxos(actionTokenPolicy) {
  const asset = actionTokenPolicy;
  const addresses = await bf(`/assets/${asset}/addresses`);
  const results = [];

  for (const addrEntry of addresses) {
    const utxos = await bf(`/addresses/${addrEntry.address}/utxos/${asset}`);
    for (const u of utxos) {
      if (u.data_hash || u.inline_datum) {
        const meshUtxo = blockfrostUtxoToMesh(u, addrEntry.address);
        if (meshUtxo.output.datumHash) {
          meshUtxo.output.plutusData = await fetchDatumJson(meshUtxo.output.datumHash);
        }
        results.push(meshUtxo);
      }
    }
  }

  return results;
}

/**
 * Convert Blockfrost UTxO format to our internal format.
 * plutusData will be null initially — call fetchDatumJson() to get parsed datum.
 */
function blockfrostUtxoToMesh(bfUtxo, address) {
  return {
    input: {
      txHash: bfUtxo.tx_hash,
      outputIndex: bfUtxo.tx_index || bfUtxo.output_index,
    },
    output: {
      address: address,
      amount: bfUtxo.amount.map(a => ({
        unit: a.unit,
        quantity: a.quantity,
      })),
      // data_hash is used to fetch the parsed JSON datum
      datumHash: bfUtxo.data_hash || null,
      plutusData: null, // populated by fetchDatumJson
    },
  };
}

/**
 * Fetch parsed JSON datum from Blockfrost using datum hash.
 * Returns the json_value in {list: [{int: ...}, ...]} format.
 */
async function fetchDatumJson(datumHash) {
  const data = await bf(`/scripts/datum/${datumHash}`);
  return data.json_value;
}

/**
 * Find UTxO by token and resolve its datum to parsed JSON.
 */
async function findUtxoWithDatum(policyId) {
  const utxo = await findUtxoByTokenRaw(policyId);
  if (utxo.output.datumHash) {
    utxo.output.plutusData = await fetchDatumJson(utxo.output.datumHash);
  }
  return utxo;
}

/**
 * Find a reference script UTxO for a given script hash.
 * Queries Blockfrost for the script's address and looks for a UTxO with script_ref.
 * Returns null if not found (caller should handle gracefully).
 */
export async function findScriptRefUtxo(scriptHash) {
  try {
    // Get the script address (where the reference script is deployed)
    const scriptInfo = await bf(`/scripts/${scriptHash}`);
    if (!scriptInfo) return null;

    // Try to find UTxOs at the script's address that contain a script ref
    // Scripts are typically deployed at their own address
    const scriptAddr = scriptInfo.script_address;
    if (!scriptAddr) return null;

    const utxos = await bf(`/addresses/${scriptAddr}/utxos`);
    if (!utxos || utxos.length === 0) return null;

    // Find a UTxO with a script reference
    for (const u of utxos) {
      if (u.reference_script_hash === scriptHash) {
        return {
          input: {
            txHash: u.tx_hash,
            outputIndex: u.tx_index || u.output_index,
          },
          output: {
            address: scriptAddr,
            amount: u.amount.map(a => ({ unit: a.unit, quantity: a.quantity })),
          },
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch address UTxOs (for wallet queries).
 */
export async function fetchAddressUtxos(address) {
  const utxos = await bf(`/addresses/${address}/utxos`, { noCache: true });
  return utxos.map(u => blockfrostUtxoToMesh(u, address));
}

/**
 * Fetch aggregated balances for a wallet address.
 * Returns array of { unit, quantity } like Blockfrost /addresses/{addr} response.
 */
export async function fetchWalletBalances(address) {
  try {
    const data = await bf(`/addresses/${address}`, { noCache: true });
    return data.amount || [];
  } catch (err) {
    // Address may not exist on chain yet
    if (err.message && err.message.includes("404")) {
      return [{ unit: "lovelace", quantity: "0" }];
    }
    throw err;
  }
}
