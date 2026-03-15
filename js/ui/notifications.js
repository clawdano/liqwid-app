// ═══════════════════════════════════════════════════════════════════
// Toast Notifications & TX Status
// ═══════════════════════════════════════════════════════════════════

const CARDANOSCAN = "https://cardanoscan.io/transaction/";

const STATUS_ICONS = {
  building: "\u231B",
  signing: "\u270D\uFE0F",
  submitting: "\u{1F4E1}",
  confirmed: "\u2705",
  error: "\u274C",
};

export function showTxStatus(status, text, txHash = null) {
  const el = document.getElementById("tx-status");
  const icon = document.getElementById("tx-status-icon");
  const textEl = document.getElementById("tx-status-text");
  const link = document.getElementById("tx-link");

  el.classList.remove("hidden");
  icon.textContent = STATUS_ICONS[status] || "";
  icon.className = `tx-icon ${status}`;
  textEl.textContent = text;

  if (txHash) {
    link.href = `${CARDANOSCAN}${txHash}`;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
}

export function hideTxStatus() {
  document.getElementById("tx-status").classList.add("hidden");
}

export function showToast(message, type = "info", duration = 4000) {
  const container = document.getElementById("toasts");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}
