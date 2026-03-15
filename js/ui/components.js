// ═══════════════════════════════════════════════════════════════════
// UI Components — DOM Rendering
// ═══════════════════════════════════════════════════════════════════

import { MARKETS, MARKET_ORDER } from "../config/markets.js";
import { state } from "./state.js";
import { findUtxoByToken, fetchWalletBalances } from "../protocol/blockfrost.js";
import { deserializeMarketState, formatMarketStats, underlyingToQTokens, qTokensToUnderlying } from "../protocol/market-state.js";
import { showToast } from "./notifications.js";

// ─── Market Grid ────────────────────────────────────────────────

export function renderMarketGrid() {
  const grid = document.getElementById("market-grid");
  grid.innerHTML = "";

  for (const id of MARKET_ORDER) {
    const market = MARKETS[id];
    if (!market) continue;

    const btn = document.createElement("button");
    btn.className = `market-btn${market.supported ? "" : " disabled"}`;
    btn.dataset.market = id;
    btn.innerHTML = `
      <div class="market-icon">${market.name.slice(0, 3)}</div>
      <span>${market.name}</span>
    `;

    if (market.supported) {
      btn.addEventListener("click", () => selectMarket(id));
    }

    grid.appendChild(btn);
  }
}

async function selectMarket(id) {
  // Update active button
  document.querySelectorAll(".market-btn").forEach(b => b.classList.remove("active"));
  const btn = document.querySelector(`.market-btn[data-market="${id}"]`);
  if (btn) btn.classList.add("active");

  state.set("selectedMarket", id);

  // Show panels
  document.getElementById("market-stats").classList.remove("hidden");
  document.getElementById("action-panel").classList.remove("hidden");

  // Update labels
  const market = MARKETS[id];
  document.getElementById("stats-title").textContent = `${market.name} Market`;
  document.getElementById("deposit-token-label").textContent = market.name;
  document.querySelectorAll(".withdraw-token-label").forEach(el => el.textContent = market.name);

  // Reset inputs
  document.getElementById("deposit-amount").value = "";
  document.getElementById("withdraw-amount").value = "";
  document.getElementById("deposit-preview").textContent = "— qTokens";
  document.getElementById("withdraw-preview").textContent = "— qTokens";

  // Load stats
  await loadMarketStats(id);
}

export async function loadMarketStats(marketId) {
  const market = MARKETS[marketId];
  const statsCard = document.getElementById("market-stats");
  statsCard.classList.add("loading-stats");

  // Set loading placeholders
  const ids = ["stat-supply", "stat-borrowed", "stat-utilization", "stat-apy", "stat-rate", "stat-available"];
  ids.forEach(id => document.getElementById(id).textContent = "Loading...");

  try {
    const utxo = await findUtxoByToken(market.marketStateToken);
    // Blockfrost inline_datum is already parsed JSON — no MeshJS deserializeDatum needed
    const datum = utxo.output.plutusData;
    const marketState = deserializeMarketState(datum);

    state.set("marketState", marketState);
    state.set("qTokenRate", marketState.qTokenRate);

    const stats = formatMarketStats(marketState, market.decimals);
    const fmt = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

    document.getElementById("stat-supply").textContent = `${fmt(stats.supply)} ${market.name}`;
    document.getElementById("stat-borrowed").textContent = `${fmt(stats.borrowed)} ${market.name}`;
    document.getElementById("stat-utilization").textContent = `${stats.utilization.toFixed(2)}%`;
    document.getElementById("stat-apy").textContent = `${stats.apy.toFixed(2)}%`;
    document.getElementById("stat-rate").textContent = `1 q${market.name} = ${stats.rate.toFixed(8)} ${market.name}`;
    document.getElementById("stat-available").textContent = `${fmt(stats.available)} ${market.name}`;
  } catch (err) {
    console.error("Failed to load market stats:", err);
    ids.forEach(id => document.getElementById(id).textContent = "Error");
    showToast(`Failed to load ${market.name} market data: ${err.message}`, "error");
  } finally {
    statsCard.classList.remove("loading-stats");
  }
}

// ─── Deposit Preview ────────────────────────────────────────────

export function updateDepositPreview() {
  const qTokenRate = state.get("qTokenRate");
  const marketId = state.get("selectedMarket");
  if (!qTokenRate || !marketId) return;

  const market = MARKETS[marketId];
  const input = document.getElementById("deposit-amount");
  const preview = document.getElementById("deposit-preview");
  const val = parseFloat(input.value);

  if (!val || val <= 0) {
    preview.textContent = `— q${market.name}`;
    return;
  }

  const amount = BigInt(Math.floor(val * (10 ** market.decimals)));
  const qTokens = underlyingToQTokens(amount, qTokenRate);
  const display = Number(qTokens) / (10 ** market.decimals);
  preview.textContent = `${display.toLocaleString(undefined, { maximumFractionDigits: 4 })} q${market.name}`;
}

// ─── Withdraw Preview ───────────────────────────────────────────

export function updateWithdrawPreview() {
  const qTokenRate = state.get("qTokenRate");
  const marketId = state.get("selectedMarket");
  if (!qTokenRate || !marketId) return;

  const market = MARKETS[marketId];
  const input = document.getElementById("withdraw-amount");
  const preview = document.getElementById("withdraw-preview");
  const previewLabel = document.getElementById("withdraw-preview-label");
  const mode = document.querySelector('input[name="withdraw-mode"]:checked')?.value || "underlying";
  const val = parseFloat(input.value);

  if (!val || val <= 0) {
    preview.textContent = mode === "underlying" ? `— q${market.name}` : `— ${market.name}`;
    return;
  }

  const amount = BigInt(Math.floor(val * (10 ** market.decimals)));

  if (mode === "underlying") {
    // User wants X underlying → calc qTokens to burn (ceil)
    const qTokensToBurn = (amount * qTokenRate[1] + qTokenRate[0] - 1n) / qTokenRate[0];
    const display = Number(qTokensToBurn) / (10 ** market.decimals);
    previewLabel.textContent = "You will burn";
    preview.textContent = `${display.toLocaleString(undefined, { maximumFractionDigits: 4 })} q${market.name}`;
  } else {
    // User wants to burn X qTokens → calc underlying received
    const underlying = qTokensToUnderlying(amount, qTokenRate);
    const display = Number(underlying) / (10 ** market.decimals);
    previewLabel.textContent = "You will receive";
    preview.textContent = `${display.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${market.name}`;
  }
}

// ─── Portfolio ──────────────────────────────────────────────────

export async function renderPortfolio() {
  const wallet = state.get("wallet");
  const portfolioSection = document.getElementById("portfolio");
  const list = document.getElementById("portfolio-list");

  if (!wallet) {
    portfolioSection.classList.add("hidden");
    return;
  }

  portfolioSection.classList.remove("hidden");
  list.innerHTML = '<p class="muted">Scanning wallet for qTokens...</p>';

  try {
    // Fetch balances from Blockfrost using the wallet's hex address
    const addrHex = state.get("walletAddressHex");
    const bech32 = state.get("walletAddress");
    const addr = bech32 || addrHex;

    const balances = await fetchWalletBalances(addr);
    state.set("walletBalances", balances);

    const positions = [];

    for (const [marketId, market] of Object.entries(MARKETS)) {
      if (!market.supported) continue;

      // Find qToken balance
      const qTokenBalance = balances.find(b => b.unit.startsWith(market.qTokenPolicy));
      if (!qTokenBalance) continue;

      const totalQTokens = BigInt(qTokenBalance.quantity);
      let underlyingValue = null;

      try {
        const qTokenRate = state.get("qTokenRate");
        if (qTokenRate && state.get("selectedMarket") === marketId) {
          underlyingValue = qTokensToUnderlying(totalQTokens, qTokenRate);
        }
      } catch {}

      positions.push({
        marketId,
        name: market.name,
        decimals: market.decimals,
        qTokens: totalQTokens,
        underlyingValue,
      });
    }

    if (positions.length === 0) {
      list.innerHTML = '<p class="muted">No qToken positions found</p>';
      return;
    }

    list.innerHTML = "";
    for (const pos of positions) {
      const div = document.createElement("div");
      div.className = "portfolio-row";

      const qDisplay = (Number(pos.qTokens) / (10 ** pos.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
      let valueHtml = "";
      if (pos.underlyingValue !== null) {
        const val = (Number(pos.underlyingValue) / (10 ** pos.decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });
        valueHtml = `<div class="value">&asymp; ${val} ${pos.name}</div>`;
      }

      div.innerHTML = `
        <span class="portfolio-token">q${pos.name}</span>
        <div class="portfolio-balance">
          <div class="amount">${qDisplay}</div>
          ${valueHtml}
        </div>
      `;
      list.appendChild(div);
    }
  } catch (err) {
    list.innerHTML = `<p class="muted">Error scanning portfolio: ${err.message}</p>`;
  }
}

// ─── Wallet Button ──────────────────────────────────────────────

export function updateWalletButton() {
  const btn = document.getElementById("wallet-btn");
  const address = state.get("walletAddress");
  const depositBtn = document.getElementById("deposit-btn");
  const withdrawBtn = document.getElementById("withdraw-btn");

  if (address) {
    btn.textContent = address.slice(0, 8) + "..." + address.slice(-6);
    btn.classList.add("connected");
    depositBtn.disabled = false;
    depositBtn.textContent = "Deposit";
    withdrawBtn.disabled = false;
    withdrawBtn.textContent = "Withdraw";
  } else {
    btn.textContent = "Connect Wallet";
    btn.classList.remove("connected");
    depositBtn.disabled = true;
    depositBtn.textContent = "Connect Wallet";
    withdrawBtn.disabled = true;
    withdrawBtn.textContent = "Connect Wallet";
  }
}

// ─── Deposit MAX ────────────────────────────────────────────────

export function setDepositMax() {
  const marketId = state.get("selectedMarket");
  const balances = state.get("walletBalances");
  if (!marketId || !balances) return;

  const market = MARKETS[marketId];
  let total = 0n;

  if (market.isNative) {
    const ada = balances.find(b => b.unit === "lovelace");
    total = ada ? BigInt(ada.quantity) : 0n;
    // Reserve 5 ADA for fees
    if (total > 5_000_000n) total -= 5_000_000n;
    else total = 0n;
  } else {
    const underlyingUnit = market.underlying.policyId + market.underlying.tokenName;
    const tok = balances.find(b => b.unit === underlyingUnit);
    total = tok ? BigInt(tok.quantity) : 0n;
  }

  if (total > 0n) {
    const display = Number(total) / (10 ** market.decimals);
    document.getElementById("deposit-amount").value = display;
    updateDepositPreview();
  }
}

// ─── Withdraw MAX ───────────────────────────────────────────────

export function setWithdrawMax() {
  const marketId = state.get("selectedMarket");
  const balances = state.get("walletBalances");
  const qTokenRate = state.get("qTokenRate");
  if (!marketId || !balances || !qTokenRate) return;

  const market = MARKETS[marketId];
  const mode = document.querySelector('input[name="withdraw-mode"]:checked')?.value || "underlying";

  const qBal = balances.find(b => b.unit.startsWith(market.qTokenPolicy));
  const totalQTokens = qBal ? BigInt(qBal.quantity) : 0n;

  if (totalQTokens > 0n) {
    if (mode === "qtokens") {
      const display = Number(totalQTokens) / (10 ** market.decimals);
      document.getElementById("withdraw-amount").value = display;
    } else {
      const underlying = qTokensToUnderlying(totalQTokens, qTokenRate);
      const display = Number(underlying) / (10 ** market.decimals);
      document.getElementById("withdraw-amount").value = display;
    }
    updateWithdrawPreview();
  }
}
