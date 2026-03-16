// ═══════════════════════════════════════════════════════════════════
// Transaction Builder — Deposit & Withdraw
// ═══════════════════════════════════════════════════════════════════

import { MeshTxBuilder, BlockfrostProvider, mConStr0 } from "@meshsdk/core";
import { MARKETS } from "../config/markets.js";
import { findUtxoByToken, findScriptRefUtxo, clearCache } from "./blockfrost.js";
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
 * Get wallet address and UTxOs from CIP-30 API via our wrapper.
 */
async function getWalletInfo() {
  const walletApi = state.get("walletApi");
  if (!walletApi) throw new Error("No wallet connected");

  // CIP-30 returns hex addresses — MeshTxBuilder accepts hex
  const changeAddr = await walletApi.getChangeAddress();

  // Get UTxOs as hex CBOR — MeshTxBuilder.selectUtxosFrom can handle these
  // when we use the provider's fetchAddressUTxOs instead
  return { changeAddr, walletApi };
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

      // Use hex address from CIP-30 API + provider-fetched UTxOs
      const { changeAddr, walletApi } = await getWalletInfo();
      const userAddress = changeAddr;
      const userUtxos = await provider.fetchAddressUTxOs(userAddress);

      // Fetch reference UTxOs and action UTxO in parallel
      const [marketStateUtxo, marketParamsUtxo, actionUtxo, actionScriptRef, qTokenScriptRef] = await Promise.all([
        findUtxoByToken(market.marketStateToken),
        findUtxoByToken(market.marketParamsToken),
        findRandomActionUtxo(market.actionToken),
        findScriptRefUtxo(market.actionScriptHash),
        findScriptRefUtxo(market.qTokenPolicy),
      ]);

      // Decode MarketState for qTokenRate
      const marketState = deserializeMarketState(marketStateUtxo.output.plutusData);
      const qTokenRate = marketState.qTokenRate;

      // Calculate qTokens to mint
      const qTokensToMint = underlyingToQTokens(depositAmount, qTokenRate);

      // Decode and update ActionDatum
      const currentActionDatum = deserializeActionDatum(actionUtxo.output.plutusData);
      const newActionDatum = updateForDeposit(currentActionDatum, depositAmount, qTokensToMint);

      // Calculate new Action UTxO value
      const currentActionLovelace = BigInt(
        actionUtxo.output.amount.find(a => a.unit === "lovelace")?.quantity || "0"
      );

      // Build action output amounts
      const actionOutputAmounts = [];
      if (market.isNative) {
        actionOutputAmounts.push({ unit: "lovelace", quantity: (currentActionLovelace + depositAmount).toString() });
      } else {
        actionOutputAmounts.push({ unit: "lovelace", quantity: currentActionLovelace.toString() });
        const underlyingUnit = market.underlying.policyId + market.underlying.tokenName;
        const existingToken = actionUtxo.output.amount.find(a => a.unit === underlyingUnit);
        const existingQty = BigInt(existingToken?.quantity || "0");
        actionOutputAmounts.push({ unit: underlyingUnit, quantity: (existingQty + depositAmount).toString() });
      }
      actionOutputAmounts.push({ unit: market.actionToken, quantity: "1" });

      // Build transaction
      const mesh = new MeshTxBuilder({ fetcher: provider, evaluator: provider });

      let txChain = mesh
        // Reference inputs (read-only state)
        .readOnlyTxInReference(marketStateUtxo.input.txHash, marketStateUtxo.input.outputIndex)
        .readOnlyTxInReference(marketParamsUtxo.input.txHash, marketParamsUtxo.input.outputIndex)
        // Spend Action UTxO via reference script
        .spendingPlutusScriptV2()
        .txIn(actionUtxo.input.txHash, actionUtxo.input.outputIndex)
        .txInInlineDatumPresent()
        .txInRedeemerValue(UNIT_REDEEMER);

      // Use reference script if found, otherwise the action UTxO itself may contain the script
      if (actionScriptRef) {
        txChain = txChain.spendingTxInReference(actionScriptRef.input.txHash, actionScriptRef.input.outputIndex, market.actionScriptHash);
      } else {
        txChain = txChain.spendingTxInReference(actionUtxo.input.txHash, actionUtxo.input.outputIndex, market.actionScriptHash);
      }

      txChain = txChain
        // Mint qTokens
        .mintPlutusScriptV2()
        .mint(qTokensToMint.toString(), market.qTokenPolicy, "");

      txChain = txChain.mintRedeemerValue(UNIT_REDEEMER);

      // Use reference script for minting if found
      if (qTokenScriptRef) {
        txChain = txChain.mintTxInReference(qTokenScriptRef.input.txHash, qTokenScriptRef.input.outputIndex);
      }

      txChain = txChain
        // Output: Updated Action UTxO
        .txOut(actionUtxo.output.address, actionOutputAmounts)
        .txOutInlineDatumValue(serializeActionDatum(newActionDatum))
        // Output: qTokens to user
        .txOut(userAddress, [
          { unit: "lovelace", quantity: "1500000" },
          { unit: market.qTokenPolicy, quantity: qTokensToMint.toString() },
        ])
        .changeAddress(userAddress)
        .selectUtxosFrom(userUtxos);

      await txChain.complete();

      const unsignedTx = mesh.txHex;

      // Sign via CIP-30 API
      showTxStatus("signing", "Waiting for wallet signature...");
      const signedTx = await walletApi.signTx(unsignedTx, true);

      // Submit
      showTxStatus("submitting", "Submitting transaction...");
      const txHash = await walletApi.submitTx(signedTx);

      showTxStatus("confirmed", `Deposit confirmed!`, txHash);
      clearCache();

      return txHash;

    } catch (err) {
      const msg = err.message || String(err);
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
      const { changeAddr, walletApi } = await getWalletInfo();
      const userAddress = changeAddr;
      const userUtxos = await provider.fetchAddressUTxOs(userAddress);

      // Fetch reference UTxOs and action UTxO in parallel
      const [marketStateUtxo, marketParamsUtxo, actionUtxo, actionScriptRef, qTokenScriptRef] = await Promise.all([
        findUtxoByToken(market.marketStateToken),
        findUtxoByToken(market.marketParamsToken),
        findRandomActionUtxo(market.actionToken),
        findScriptRefUtxo(market.actionScriptHash),
        findScriptRefUtxo(market.qTokenPolicy),
      ]);

      // Decode MarketState
      const marketState = deserializeMarketState(marketStateUtxo.output.plutusData);
      const qTokenRate = marketState.qTokenRate;

      // Calculate amounts based on mode
      let withdrawAmount, qTokensToBurn;
      if (mode === "underlying") {
        withdrawAmount = BigInt(Math.floor(amountHuman * (10 ** decimals)));
        qTokensToBurn = (withdrawAmount * qTokenRate[1] + qTokenRate[0] - 1n) / qTokenRate[0];
      } else {
        qTokensToBurn = BigInt(Math.floor(amountHuman * (10 ** decimals)));
        withdrawAmount = qTokensToUnderlying(qTokensToBurn, qTokenRate);
      }

      // Decode and update ActionDatum
      const currentActionDatum = deserializeActionDatum(actionUtxo.output.plutusData);
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

      // Build transaction
      const mesh = new MeshTxBuilder({ fetcher: provider, evaluator: provider });

      let txChain = mesh
        // Reference inputs
        .readOnlyTxInReference(marketStateUtxo.input.txHash, marketStateUtxo.input.outputIndex)
        .readOnlyTxInReference(marketParamsUtxo.input.txHash, marketParamsUtxo.input.outputIndex)
        // Spend Action UTxO
        .spendingPlutusScriptV2()
        .txIn(actionUtxo.input.txHash, actionUtxo.input.outputIndex)
        .txInInlineDatumPresent()
        .txInRedeemerValue(UNIT_REDEEMER);

      if (actionScriptRef) {
        txChain = txChain.spendingTxInReference(actionScriptRef.input.txHash, actionScriptRef.input.outputIndex, market.actionScriptHash);
      } else {
        txChain = txChain.spendingTxInReference(actionUtxo.input.txHash, actionUtxo.input.outputIndex, market.actionScriptHash);
      }

      // Burn qTokens (negative mint)
      txChain = txChain
        .mintPlutusScriptV2()
        .mint("-" + qTokensToBurn.toString(), market.qTokenPolicy, "")
        .mintRedeemerValue(UNIT_REDEEMER);

      if (qTokenScriptRef) {
        txChain = txChain.mintTxInReference(qTokenScriptRef.input.txHash, qTokenScriptRef.input.outputIndex);
      }

      txChain = txChain
        // Output: Updated Action UTxO
        .txOut(actionUtxo.output.address, actionOutputAmounts)
        .txOutInlineDatumValue(serializeActionDatum(newActionDatum))
        // Output: underlying to user
        .txOut(userAddress, userReceiveAmounts)
        .changeAddress(userAddress)
        .selectUtxosFrom(userUtxos);

      await txChain.complete();

      const unsignedTx = mesh.txHex;

      showTxStatus("signing", "Waiting for wallet signature...");
      const signedTx = await walletApi.signTx(unsignedTx, true);

      showTxStatus("submitting", "Submitting transaction...");
      const txHash = await walletApi.submitTx(signedTx);

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
