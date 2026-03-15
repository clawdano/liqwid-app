// ═══════════════════════════════════════════════════════════════════
// Transaction Builder — Deposit & Withdraw
// ═══════════════════════════════════════════════════════════════════

import { MeshTxBuilder, BlockfrostProvider, deserializeDatum, mConStr0 } from "@meshsdk/core";
import { MARKETS } from "../config/markets.js";
import { findUtxoByToken, clearCache } from "./blockfrost.js";
import { deserializeMarketState, underlyingToQTokens, qTokensToUnderlying } from "./market-state.js";
import {
  deserializeActionDatum,
  serializeActionDatum,
  findRandomActionUtxo,
  updateForDeposit,
  updateForWithdraw,
} from "./action-datum.js";
import { state } from "../ui/state.js";
import { showTxStatus, hideTxStatus, showToast } from "../ui/notifications.js";

const BLOCKFROST_KEY = "mainnetmYbTW9Ne1hmN5am2IohNI96Db4IZWWdw";
const UNIT_REDEEMER = mConStr0([]);
const MAX_RETRIES = 3;

function getProvider() {
  return new BlockfrostProvider(BLOCKFROST_KEY);
}

/**
 * Build and submit a deposit transaction.
 */
export async function executeDeposit(marketId, amountHuman) {
  const market = MARKETS[marketId];
  const decimals = market.decimals;
  const depositAmount = BigInt(Math.floor(amountHuman * (10 ** decimals)));

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      showTxStatus("building", "Building deposit transaction...");

      const provider = getProvider();
      const wallet = state.get("wallet");
      const userAddress = await wallet.getChangeAddress();

      // Fetch reference UTxOs
      const [marketStateUtxo, marketParamsUtxo] = await Promise.all([
        findUtxoByToken(market.marketStateToken),
        findUtxoByToken(market.marketParamsToken),
      ]);

      // Pick random Action UTxO
      const actionUtxo = await findRandomActionUtxo(market.actionToken);

      // Decode MarketState for qTokenRate
      const marketStateDatum = deserializeDatum(marketStateUtxo.output.plutusData);
      const marketState = deserializeMarketState(marketStateDatum);
      const qTokenRate = marketState.qTokenRate;

      // Calculate qTokens to mint
      const qTokensToMint = underlyingToQTokens(depositAmount, qTokenRate);

      // Decode and update ActionDatum
      const actionDatumRaw = deserializeDatum(actionUtxo.output.plutusData);
      const currentActionDatum = deserializeActionDatum(actionDatumRaw);
      const newActionDatum = updateForDeposit(currentActionDatum, depositAmount, qTokensToMint);

      // Calculate new Action UTxO value
      const currentActionLovelace = BigInt(
        actionUtxo.output.amount.find(a => a.unit === "lovelace")?.quantity || "0"
      );

      // Build action output amounts
      const actionOutputAmounts = [];
      if (market.isNative) {
        // ADA market: add deposit lovelace to action
        actionOutputAmounts.push({ unit: "lovelace", quantity: (currentActionLovelace + depositAmount).toString() });
      } else {
        // Non-ADA: keep existing lovelace, add native token
        actionOutputAmounts.push({ unit: "lovelace", quantity: currentActionLovelace.toString() });
        // Find existing native token amount in action UTxO
        const underlyingUnit = market.underlying.policyId + market.underlying.tokenName;
        const existingToken = actionUtxo.output.amount.find(a => a.unit === underlyingUnit);
        const existingQty = BigInt(existingToken?.quantity || "0");
        actionOutputAmounts.push({ unit: underlyingUnit, quantity: (existingQty + depositAmount).toString() });
      }
      // Always include action token
      actionOutputAmounts.push({ unit: market.actionToken, quantity: "1" });

      // Build transaction
      const mesh = new MeshTxBuilder({ fetcher: provider, evaluator: provider });

      const userUtxos = await wallet.getUtxos();

      await mesh
        // Reference inputs
        .readOnlyTxInReference(marketStateUtxo.input.txHash, marketStateUtxo.input.outputIndex)
        .readOnlyTxInReference(marketParamsUtxo.input.txHash, marketParamsUtxo.input.outputIndex)
        // Spend Action UTxO
        .spendingPlutusScriptV2()
        .txIn(actionUtxo.input.txHash, actionUtxo.input.outputIndex)
        .txInInlineDatumPresent()
        .txInRedeemerValue(UNIT_REDEEMER)
        .spendingTxInReference(actionUtxo.input.txHash, actionUtxo.input.outputIndex)
        // Mint qTokens
        .mintPlutusScriptV2()
        .mint(qTokensToMint.toString(), market.qTokenPolicy, "")
        .mintRedeemerValue(UNIT_REDEEMER)
        .mintingScript(market.qTokenPolicy)
        // Output: Updated Action UTxO
        .txOut(actionUtxo.output.address, actionOutputAmounts)
        .txOutInlineDatumValue(serializeActionDatum(newActionDatum))
        // Output: qTokens to user
        .txOut(userAddress, [
          { unit: "lovelace", quantity: "1500000" },
          { unit: market.qTokenPolicy, quantity: qTokensToMint.toString() },
        ])
        .changeAddress(userAddress)
        .selectUtxosFrom(userUtxos)
        .complete();

      const unsignedTx = mesh.txHex;

      // Sign
      showTxStatus("signing", "Waiting for wallet signature...");
      const signedTx = await wallet.signTx(unsignedTx);

      // Submit
      showTxStatus("submitting", "Submitting transaction...");
      const txHash = await wallet.submitTx(signedTx);

      showTxStatus("confirmed", `Deposit confirmed!`, txHash);
      clearCache();

      return txHash;

    } catch (err) {
      const msg = err.message || String(err);
      // Retry on contention (UTxO already spent)
      if (attempt < MAX_RETRIES - 1 && (msg.includes("UTxO") || msg.includes("already spent") || msg.includes("contention"))) {
        clearCache();
        showToast(`Contention detected, retrying with different Action UTxO... (${attempt + 2}/${MAX_RETRIES})`, "info");
        continue;
      }
      showTxStatus("error", `Deposit failed: ${msg}`);
      throw err;
    }
  }
}

/**
 * Build and submit a withdraw transaction.
 * mode: "underlying" (user specifies underlying amount) or "qtokens" (user specifies qTokens to burn)
 */
export async function executeWithdraw(marketId, amountHuman, mode = "underlying") {
  const market = MARKETS[marketId];
  const decimals = market.decimals;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      showTxStatus("building", "Building withdraw transaction...");

      const provider = getProvider();
      const wallet = state.get("wallet");
      const userAddress = await wallet.getChangeAddress();

      // Fetch reference UTxOs
      const [marketStateUtxo, marketParamsUtxo] = await Promise.all([
        findUtxoByToken(market.marketStateToken),
        findUtxoByToken(market.marketParamsToken),
      ]);

      // Pick random Action UTxO
      const actionUtxo = await findRandomActionUtxo(market.actionToken);

      // Decode MarketState
      const marketStateDatum = deserializeDatum(marketStateUtxo.output.plutusData);
      const marketState = deserializeMarketState(marketStateDatum);
      const qTokenRate = marketState.qTokenRate;

      // Calculate amounts based on mode
      let withdrawAmount, qTokensToBurn;
      if (mode === "underlying") {
        withdrawAmount = BigInt(Math.floor(amountHuman * (10 ** decimals)));
        // Ceil division for burning: ceil(underlying / rate) = ceil(underlying * denom / num)
        qTokensToBurn = (withdrawAmount * qTokenRate[1] + qTokenRate[0] - 1n) / qTokenRate[0];
      } else {
        // User specified qTokens
        qTokensToBurn = BigInt(Math.floor(amountHuman * (10 ** decimals)));
        withdrawAmount = qTokensToUnderlying(qTokensToBurn, qTokenRate);
      }

      // Decode and update ActionDatum
      const actionDatumRaw = deserializeDatum(actionUtxo.output.plutusData);
      const currentActionDatum = deserializeActionDatum(actionDatumRaw);
      const newActionDatum = updateForWithdraw(currentActionDatum, withdrawAmount, qTokensToBurn);

      // Calculate new Action UTxO value
      const currentActionLovelace = BigInt(
        actionUtxo.output.amount.find(a => a.unit === "lovelace")?.quantity || "0"
      );

      // Build action output amounts
      const actionOutputAmounts = [];
      if (market.isNative) {
        actionOutputAmounts.push({ unit: "lovelace", quantity: (currentActionLovelace - withdrawAmount).toString() });
      } else {
        actionOutputAmounts.push({ unit: "lovelace", quantity: currentActionLovelace.toString() });
        const underlyingUnit = market.underlying.policyId + market.underlying.tokenName;
        const existingToken = actionUtxo.output.amount.find(a => a.unit === underlyingUnit);
        const existingQty = BigInt(existingToken?.quantity || "0");
        actionOutputAmounts.push({ unit: underlyingUnit, quantity: (existingQty - withdrawAmount).toString() });
      }
      actionOutputAmounts.push({ unit: market.actionToken, quantity: "1" });

      // Build user receive output
      const userReceiveAmounts = [];
      if (market.isNative) {
        userReceiveAmounts.push({ unit: "lovelace", quantity: withdrawAmount.toString() });
      } else {
        userReceiveAmounts.push({ unit: "lovelace", quantity: "1500000" });
        const underlyingUnit = market.underlying.policyId + market.underlying.tokenName;
        userReceiveAmounts.push({ unit: underlyingUnit, quantity: withdrawAmount.toString() });
      }

      // Find user's qToken UTxO
      const userUtxos = await wallet.getUtxos();

      // Build transaction
      const mesh = new MeshTxBuilder({ fetcher: provider, evaluator: provider });

      await mesh
        // Reference inputs
        .readOnlyTxInReference(marketStateUtxo.input.txHash, marketStateUtxo.input.outputIndex)
        .readOnlyTxInReference(marketParamsUtxo.input.txHash, marketParamsUtxo.input.outputIndex)
        // Spend Action UTxO
        .spendingPlutusScriptV2()
        .txIn(actionUtxo.input.txHash, actionUtxo.input.outputIndex)
        .txInInlineDatumPresent()
        .txInRedeemerValue(UNIT_REDEEMER)
        .spendingTxInReference(actionUtxo.input.txHash, actionUtxo.input.outputIndex)
        // Burn qTokens (negative mint)
        .mintPlutusScriptV2()
        .mint("-" + qTokensToBurn.toString(), market.qTokenPolicy, "")
        .mintRedeemerValue(UNIT_REDEEMER)
        .mintingScript(market.qTokenPolicy)
        // Output: Updated Action UTxO
        .txOut(actionUtxo.output.address, actionOutputAmounts)
        .txOutInlineDatumValue(serializeActionDatum(newActionDatum))
        // Output: underlying to user
        .txOut(userAddress, userReceiveAmounts)
        .changeAddress(userAddress)
        .selectUtxosFrom(userUtxos)
        .complete();

      const unsignedTx = mesh.txHex;

      showTxStatus("signing", "Waiting for wallet signature...");
      const signedTx = await wallet.signTx(unsignedTx);

      showTxStatus("submitting", "Submitting transaction...");
      const txHash = await wallet.submitTx(signedTx);

      showTxStatus("confirmed", `Withdrawal confirmed!`, txHash);
      clearCache();

      return txHash;

    } catch (err) {
      const msg = err.message || String(err);
      if (attempt < MAX_RETRIES - 1 && (msg.includes("UTxO") || msg.includes("already spent") || msg.includes("contention"))) {
        clearCache();
        showToast(`Contention detected, retrying... (${attempt + 2}/${MAX_RETRIES})`, "info");
        continue;
      }
      showTxStatus("error", `Withdraw failed: ${msg}`);
      throw err;
    }
  }
}
