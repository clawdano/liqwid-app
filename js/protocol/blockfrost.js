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
 * Find all UTxOs holding a given token (policyId with empty token name).
 * Returns the first UTxO that contains the token with inline datum.
 */
export async function findUtxoByToken(policyId) {
  // Get addresses holding this asset
  const asset = policyId; // empty token name → asset = policyId alone
  const addresses = await bf(`/assets/${asset}/addresses`);

  if (!addresses || addresses.length === 0) {
    throw new Error(`No addresses found for token ${policyId.slice(0, 16)}...`);
  }

  // Try each address until we find UTxO with this token and inline datum
  for (const addrEntry of addresses) {
    const utxos = await bf(`/addresses/${addrEntry.address}/utxos/${asset}`);
    if (utxos && utxos.length > 0) {
      // Return first UTxO with inline datum
      for (const u of utxos) {
        if (u.inline_datum) {
          return blockfrostUtxoToMesh(u, addrEntry.address);
        }
      }
    }
  }

  throw new Error(`No UTxO with inline datum found for token ${policyId.slice(0, 16)}...`);
}

/**
 * Find all Action UTxOs for a market (for random selection / contention avoidance).
 */
export async function findAllActionUtxos(actionTokenPolicy) {
  const asset = actionTokenPolicy;
  const addresses = await bf(`/assets/${asset}/addresses`);
  const results = [];

  for (const addrEntry of addresses) {
    const utxos = await bf(`/addresses/${addrEntry.address}/utxos/${asset}`);
    for (const u of utxos) {
      if (u.inline_datum) {
        results.push(blockfrostUtxoToMesh(u, addrEntry.address));
      }
    }
  }

  return results;
}

/**
 * Convert Blockfrost UTxO format to MeshJS-compatible format.
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
      plutusData: bfUtxo.inline_datum,
    },
  };
}

/**
 * Fetch address UTxOs (for wallet queries).
 */
export async function fetchAddressUtxos(address) {
  const utxos = await bf(`/addresses/${address}/utxos`, { noCache: true });
  return utxos.map(u => blockfrostUtxoToMesh(u, address));
}
