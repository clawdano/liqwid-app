// ═══════════════════════════════════════════════════════════════════
// ActionDatum Handling
// ═══════════════════════════════════════════════════════════════════

import { findAllActionUtxos } from "./blockfrost.js";

/**
 * Deserialize ActionDatum from Plutus datum JSON.
 * ActionDatum = [[supplyDiff, qTokensDiff, principalDiff, interestDiff, extraInterestRepaid], reservedSupply]
 */
export function deserializeActionDatum(plutusData) {
  const fields = plutusData.list;
  const av = fields[0].list;
  return {
    actionValue: {
      supplyDiff:          BigInt(av[0].int),
      qTokensDiff:         BigInt(av[1].int),
      principalDiff:       BigInt(av[2].int),
      interestDiff:        BigInt(av[3].int),
      extraInterestRepaid: BigInt(av[4].int),
    },
    reservedSupply: BigInt(fields[1].int),
  };
}

/**
 * Serialize ActionDatum to Plutus datum JSON.
 */
export function serializeActionDatum(datum) {
  return {
    list: [
      {
        list: [
          { int: datum.actionValue.supplyDiff.toString() },
          { int: datum.actionValue.qTokensDiff.toString() },
          { int: datum.actionValue.principalDiff.toString() },
          { int: datum.actionValue.interestDiff.toString() },
          { int: datum.actionValue.extraInterestRepaid.toString() },
        ],
      },
      { int: datum.reservedSupply.toString() },
    ],
  };
}

/**
 * Pick a random Action UTxO from available ones (contention avoidance).
 */
export async function findRandomActionUtxo(actionTokenPolicy) {
  const utxos = await findAllActionUtxos(actionTokenPolicy);
  if (utxos.length === 0) {
    throw new Error("No Action UTxOs found");
  }
  const idx = Math.floor(Math.random() * utxos.length);
  return utxos[idx];
}

/**
 * Update ActionDatum for a deposit.
 */
export function updateForDeposit(datum, depositAmount, qTokensToMint) {
  return {
    actionValue: {
      supplyDiff:          datum.actionValue.supplyDiff + depositAmount,
      qTokensDiff:         datum.actionValue.qTokensDiff + qTokensToMint,
      principalDiff:       datum.actionValue.principalDiff,
      interestDiff:        datum.actionValue.interestDiff,
      extraInterestRepaid: datum.actionValue.extraInterestRepaid,
    },
    reservedSupply: datum.reservedSupply,
  };
}

/**
 * Update ActionDatum for a withdrawal.
 */
export function updateForWithdraw(datum, withdrawAmount, qTokensToBurn) {
  return {
    actionValue: {
      supplyDiff:          datum.actionValue.supplyDiff - withdrawAmount,
      qTokensDiff:         datum.actionValue.qTokensDiff - qTokensToBurn,
      principalDiff:       datum.actionValue.principalDiff,
      interestDiff:        datum.actionValue.interestDiff,
      extraInterestRepaid: datum.actionValue.extraInterestRepaid,
    },
    reservedSupply: datum.reservedSupply,
  };
}
