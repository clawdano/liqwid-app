// ═══════════════════════════════════════════════════════════════════
// MarketState Parsing & qToken Math
// ═══════════════════════════════════════════════════════════════════

/**
 * Deserialize MarketState from Plutus datum (MeshJS JSON format).
 * MarketState = list of 11 fields.
 */
export function deserializeMarketState(plutusData) {
  const fields = plutusData.list;
  return {
    supply:           BigInt(fields[0].int),
    reserve:          BigInt(fields[1].int),
    qTokens:          BigInt(fields[2].int),
    principal:        BigInt(fields[3].int),
    interest:         BigInt(fields[4].int),
    interestIndex:    BigInt(fields[5].int),
    interestRate:     [BigInt(fields[6].list[0].int), BigInt(fields[6].list[1].int)],
    lastInterestTime: BigInt(fields[7].int),
    lastBatch:        BigInt(fields[8].int),
    qTokenRate:       [BigInt(fields[9].list[0].int), BigInt(fields[9].list[1].int)],
    minAda:           BigInt(fields[10].int),
  };
}

/**
 * Calculate qTokens to mint for a given deposit amount.
 * qTokens = depositAmount * denominator / numerator
 */
export function underlyingToQTokens(amount, qTokenRate) {
  return (amount * qTokenRate[1]) / qTokenRate[0];
}

/**
 * Calculate underlying to receive for given qTokens.
 * underlying = qTokens * numerator / denominator
 */
export function qTokensToUnderlying(qTokens, qTokenRate) {
  return (qTokens * qTokenRate[0]) / qTokenRate[1];
}

/**
 * Calculate utilization rate as a percentage.
 */
export function calculateUtilization(state) {
  const total = state.supply + state.principal;
  if (total === 0n) return 0;
  return Number(state.principal * 10000n / total) / 100;
}

/**
 * Calculate approximate supply APY from interest rate and utilization.
 * This is a simplified estimate — actual APY depends on the interest model.
 */
export function calculateSupplyAPY(state) {
  const utilization = calculateUtilization(state);
  if (state.interestRate[1] === 0n) return 0;
  const borrowRate = Number(state.interestRate[0]) / Number(state.interestRate[1]);
  // Supply APY ~ borrowRate * utilization * (1 - reserveFactor)
  // Assuming reserveFactor ~10%
  const supplyRate = borrowRate * (utilization / 100) * 0.9;
  // Annualize (rate is per-second, ~31.5M seconds/year)
  const apy = supplyRate * 31_536_000 * 100;
  return apy;
}

/**
 * Format a market state into display-friendly values.
 */
export function formatMarketStats(state, decimals) {
  const divisor = 10 ** decimals;
  const supply = Number(state.supply) / divisor;
  const borrowed = Number(state.principal) / divisor;
  const utilization = calculateUtilization(state);
  const apy = calculateSupplyAPY(state);
  const rate = Number(state.qTokenRate[0]) / Number(state.qTokenRate[1]);
  const available = supply - borrowed;

  return { supply, borrowed, utilization, apy, rate, available };
}
