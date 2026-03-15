// ═══════════════════════════════════════════════════════════════════
// CIP-30 Wallet Connection
// ═══════════════════════════════════════════════════════════════════

import { BrowserWallet } from "@meshsdk/core";
import { state } from "../ui/state.js";

const KNOWN_WALLETS = ["nami", "eternl", "lace", "flint", "gerowallet", "typhoncip30", "nufi", "begin", "vespr"];

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
  const wallet = await BrowserWallet.enable(name);
  const address = (await wallet.getChangeAddress());
  const utxos = await wallet.getUtxos();

  state.set("wallet", wallet);
  state.set("walletName", name);
  state.set("walletAddress", address);
  state.set("walletUtxos", utxos);

  return { wallet, address, utxos };
}

export async function refreshWalletUtxos() {
  const wallet = state.get("wallet");
  if (!wallet) return [];
  const utxos = await wallet.getUtxos();
  state.set("walletUtxos", utxos);
  return utxos;
}

export async function getChangeAddress() {
  const wallet = state.get("wallet");
  if (!wallet) throw new Error("Wallet not connected");
  return wallet.getChangeAddress();
}

export function shortenAddress(addr) {
  if (!addr || addr.length < 20) return addr;
  return addr.slice(0, 12) + "..." + addr.slice(-8);
}
