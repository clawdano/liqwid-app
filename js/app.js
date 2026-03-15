// ═══════════════════════════════════════════════════════════════════
// Liqwid App — Entry Point
// ═══════════════════════════════════════════════════════════════════

import { state } from "./ui/state.js";
import { showToast, hideTxStatus } from "./ui/notifications.js";
import { detectWallets, connectWallet } from "./wallet/connection.js";
import {
  renderMarketGrid,
  loadMarketStats,
  updateDepositPreview,
  updateWithdrawPreview,
  renderPortfolio,
  updateWalletButton,
  setDepositMax,
  setWithdrawMax,
} from "./ui/components.js";

// Lazy-load tx-builder only when needed (it pulls in MeshJS)
let txBuilder = null;
async function getTxBuilder() {
  if (!txBuilder) {
    txBuilder = await import("./protocol/tx-builder.js");
  }
  return txBuilder;
}

// ─── Init ───────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  try {
    renderMarketGrid();
    wireWalletButton();
    wireTabs();
    wireDepositForm();
    wireWithdrawForm();
    wireTxStatusClose();

    // React to wallet connection
    state.on("walletAddress", () => {
      updateWalletButton();
      renderPortfolio();
    });

    console.log("[Liqwid App] Initialized");
  } catch (err) {
    console.error("[Liqwid App] Init failed:", err);
  }
});

// ─── Wallet ─────────────────────────────────────────────────────

function wireWalletButton() {
  const btn = document.getElementById("wallet-btn");

  btn.addEventListener("click", async () => {
    if (state.get("wallet")) {
      document.getElementById("portfolio").classList.toggle("hidden");
      return;
    }

    const wallets = detectWallets();
    if (wallets.length === 0) {
      showToast("No CIP-30 wallet detected. Install Eternl, Nami, or Lace.", "error");
      return;
    }

    if (wallets.length === 1) {
      await doConnect(wallets[0].name);
      return;
    }

    showWalletPicker(wallets);
  });
}

function showWalletPicker(wallets) {
  document.querySelector(".wallet-picker")?.remove();

  const picker = document.createElement("div");
  picker.className = "wallet-picker";
  picker.style.cssText = `
    position: fixed; inset: 0; z-index: 300;
    background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
  `;

  const inner = document.createElement("div");
  inner.style.cssText = `
    background: #161b22; border: 1px solid #30363d; border-radius: 12px;
    padding: 24px; min-width: 280px; max-width: 360px;
  `;
  inner.innerHTML = `<h3 style="margin-bottom:16px;font-size:1rem;color:#e6edf3;">Select Wallet</h3>`;

  for (const w of wallets) {
    const btn = document.createElement("button");
    btn.className = "btn btn-full";
    btn.style.cssText = "margin-bottom:8px;text-align:left;padding:12px 16px;";
    btn.textContent = w.label;
    btn.addEventListener("click", async () => {
      picker.remove();
      await doConnect(w.name);
    });
    inner.appendChild(btn);
  }

  const cancel = document.createElement("button");
  cancel.className = "btn btn-full";
  cancel.style.marginTop = "8px";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => picker.remove());
  inner.appendChild(cancel);

  picker.appendChild(inner);
  picker.addEventListener("click", (e) => { if (e.target === picker) picker.remove(); });
  document.body.appendChild(picker);
}

async function doConnect(walletName) {
  const btn = document.getElementById("wallet-btn");
  try {
    btn.textContent = "Connecting...";
    btn.disabled = true;

    await connectWallet(walletName);
    showToast(`Connected to ${walletName}`, "success");
  } catch (err) {
    console.error("Wallet connect failed:", err);
    showToast(`Failed to connect: ${err.message}`, "error");
    state.set("wallet", null);
    state.set("walletAddress", null);
  } finally {
    btn.disabled = false;
    updateWalletButton();
  }
}

// ─── Tabs ───────────────────────────────────────────────────────

function wireTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
    });
  });
}

// ─── Deposit ────────────────────────────────────────────────────

function wireDepositForm() {
  const input = document.getElementById("deposit-amount");
  const maxBtn = document.getElementById("deposit-max");
  const submitBtn = document.getElementById("deposit-btn");

  input.addEventListener("input", updateDepositPreview);
  maxBtn.addEventListener("click", setDepositMax);

  submitBtn.addEventListener("click", async () => {
    const marketId = state.get("selectedMarket");
    const val = parseFloat(input.value);
    if (!marketId || !val || val <= 0) {
      showToast("Enter a valid deposit amount", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Processing...";

    try {
      const tb = await getTxBuilder();
      await tb.executeDeposit(marketId, val);
      input.value = "";
      updateDepositPreview();
      await Promise.all([loadMarketStats(marketId), renderPortfolio()]);
    } catch (err) {
      console.error("Deposit failed:", err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Deposit";
    }
  });
}

// ─── Withdraw ───────────────────────────────────────────────────

function wireWithdrawForm() {
  const input = document.getElementById("withdraw-amount");
  const maxBtn = document.getElementById("withdraw-max");
  const submitBtn = document.getElementById("withdraw-btn");
  const modeRadios = document.querySelectorAll('input[name="withdraw-mode"]');

  input.addEventListener("input", updateWithdrawPreview);
  maxBtn.addEventListener("click", setWithdrawMax);
  modeRadios.forEach(r => r.addEventListener("change", () => {
    input.value = "";
    updateWithdrawPreview();
  }));

  submitBtn.addEventListener("click", async () => {
    const marketId = state.get("selectedMarket");
    const val = parseFloat(input.value);
    const mode = document.querySelector('input[name="withdraw-mode"]:checked')?.value || "underlying";

    if (!marketId || !val || val <= 0) {
      showToast("Enter a valid withdraw amount", "error");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Processing...";

    try {
      const tb = await getTxBuilder();
      await tb.executeWithdraw(marketId, val, mode);
      input.value = "";
      updateWithdrawPreview();
      await Promise.all([loadMarketStats(marketId), renderPortfolio()]);
    } catch (err) {
      console.error("Withdraw failed:", err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Withdraw";
    }
  });
}

// ─── TX Status Close ────────────────────────────────────────────

function wireTxStatusClose() {
  document.getElementById("tx-status-close").addEventListener("click", hideTxStatus);
}
