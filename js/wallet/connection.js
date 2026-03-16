// ═══════════════════════════════════════════════════════════════════
// CIP-30 Wallet Connection (raw API — no MeshJS dependency)
// ═══════════════════════════════════════════════════════════════════

import { state } from "../ui/state.js";

const KNOWN_WALLETS = ["eternl", "nami", "lace", "flint", "gerowallet", "typhoncip30", "nufi", "begin", "vespr"];

export function detectWallets() {
  if (!window.cardano) return [];
  const found = [];
  for (const name of KNOWN_WALLETS) {
    if (window.cardano[name]) {
      found.push({
        name,
        icon: window.cardano[name].icon || null,
        label: window.cardano[name].name || name,
      });
    }
  }
  return found;
}

export async function connectWallet(name) {
  const api = await window.cardano[name].enable();

  // Get change address (hex-encoded per CIP-30)
  const changeAddrHex = await api.getChangeAddress();

  // Get used addresses
  const usedAddrs = await api.getUsedAddresses();
  const primaryAddrHex = usedAddrs[0] || changeAddrHex;

  // Convert hex to bech32 for display and Blockfrost queries
  const bech32Addr = hexAddrToBech32(primaryAddrHex);

  state.set("walletApi", api);
  state.set("walletName", name);
  state.set("walletAddress", bech32Addr);
  state.set("walletAddressHex", changeAddrHex);

  // Wrapper matching the interface tx-builder.js expects
  state.set("wallet", {
    getChangeAddress: async () => changeAddrHex,
    getUtxos: async () => (await api.getUtxos()) || [],
    signTx: async (txHex) => api.signTx(txHex, true),
    submitTx: async (txHex) => api.submitTx(txHex),
  });

  return { api, address: bech32Addr };
}

/**
 * Convert a hex-encoded Shelley address to bech32.
 * Pure JS — no external dependencies.
 */
function hexAddrToBech32(hex) {
  try {
    const bytes = hexToBytes(hex);
    // Header byte: upper nibble = type, lower nibble = network
    const header = bytes[0];
    const network = header & 0x0f;
    const prefix = network === 1 ? "addr" : "addr_test";
    return bech32Encode(prefix, bytes);
  } catch {
    // Fallback: return hex (Blockfrost accepts hex too)
    return hex;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// ─── Bech32 encoder (pure JS) ───────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((b >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

function bech32CreateChecksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const polymod = bech32Polymod(values) ^ 1; // bech32 (NOT bech32m)
  const ret = [];
  for (let i = 0; i < 6; i++) ret.push((polymod >> (5 * (5 - i))) & 31);
  return ret;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  }
  return ret;
}

function bech32Encode(hrp, data) {
  const data5bit = convertBits(data, 8, 5, true);
  const checksum = bech32CreateChecksum(hrp, data5bit);
  let result = hrp + "1";
  for (const d of data5bit.concat(checksum)) {
    result += BECH32_CHARSET[d];
  }
  return result;
}

export function shortenAddress(addr) {
  if (!addr || addr.length < 20) return addr;
  return addr.slice(0, 12) + "..." + addr.slice(-6);
}
