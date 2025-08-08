/**
 * Calculate FCT output for given mining parameters
 * Uses baseFee for FCT minting, gasPrice for cost estimation
 */
export function calculateFctOutput(params: {
  dataSize: number;
  baseFee: bigint;
  mintRate: bigint;
  calldataGasOverride?: bigint;
  gasPrice?: bigint; // Optional: actual gas price for cost estimation
}): {
  calldataGas: bigint;
  fctMinted: bigint;
  efficiency: number;
  totalGas: bigint;
  ethBurned: bigint;
  costPerFct: bigint;
} {
  const baseExecutionGas = 21000n;
  const overheadBytes = 160;
  const mineBoostSize = Math.max(params.dataSize - overheadBytes, 0);
  
  // Calculate calldata gas correctly
  // Using pattern "FACETMINE" which is all non-zero bytes
  // Non-zero byte = 40 gas, zero byte = 10 gas
  const calldataGas =
    params.calldataGasOverride ??
    BigInt(mineBoostSize * 40); // All non-zero bytes
  
  const totalGas = calldataGas + baseExecutionGas;
  
  // FCT is minted based on calldata gas * baseFee * mintRate
  // CRITICAL: Always use baseFee for minting calculation
  const fctMinted = calldataGas * params.baseFee * params.mintRate;
  
  // Calculate efficiency (how much gas goes to mining vs overhead)
  const efficiency = (Number(calldataGas) / Number(totalGas)) * 100;
  
  // ETH burned uses gasPrice if provided (actual cost), otherwise baseFee (estimate)
  const effectiveGasPrice = params.gasPrice ?? params.baseFee;
  const ethBurned = totalGas * effectiveGasPrice;
  
  // Cost per FCT in wei
  const costPerFct = fctMinted > 0n ? (ethBurned * 10n ** 18n) / fctMinted : 0n;
  
  return {
    calldataGas,
    fctMinted,
    efficiency,
    totalGas,
    ethBurned,
    costPerFct,
  };
}

/**
 * Calculate required data size to mine target FCT amount
 */
export function calculateRequiredDataSize(params: {
  targetFct: bigint;
  baseFee: bigint;
  mintRate: bigint;
  maxDataSize?: number;
}): {
  dataSize: number;
  feasible: boolean;
  estimatedGas: bigint;
  estimatedEth: bigint;
} {
  const maxSize = params.maxDataSize ?? 102400; // 100KB default max
  const overheadBytes = 160;
  const baseExecutionGas = 21000n;
  
  // Calculate required calldata gas
  const requiredCalldataGas = params.targetFct / (params.baseFee * params.mintRate);
  
  // Calculate bytes needed - our pattern uses all non-zero bytes
  // Non-zero byte = 40 gas
  const estimatedBytes = Number(requiredCalldataGas / 40n);
  const dataSize = estimatedBytes + overheadBytes;
  
  const feasible = dataSize <= maxSize;
  const actualDataSize = feasible ? dataSize : maxSize;
  
  // Calculate actual gas for the chosen size
  const result = calculateFctOutput({
    dataSize: actualDataSize,
    baseFee: params.baseFee,
    mintRate: params.mintRate,
  });
  
  return {
    dataSize: actualDataSize,
    feasible,
    estimatedGas: result.totalGas,
    estimatedEth: result.ethBurned,
  };
}

/**
 * Calculate FCT from actual L1 gas used (post-transaction)
 * This is more accurate than pre-transaction estimation
 */
export function calculateFctFromActualGas(params: {
  gasUsed: bigint;
  baseFee: bigint;
  mintRate: bigint;
}): bigint {
  const baseExecutionGas = 21000n;
  const calldataGas = params.gasUsed - baseExecutionGas;
  return calldataGas * params.baseFee * params.mintRate;
}

/**
 * Compare mining cost vs DEX price to find arbitrage opportunities
 */
export function calculateArbitrage(params: {
  miningCostPerFct: bigint; // ETH per FCT from mining
  dexPricePerFct: bigint;   // ETH per FCT from DEX
}): {
  profitable: boolean;
  savingsPercent: number;
  savingsPerFct: bigint;
} {
  const profitable = params.miningCostPerFct < params.dexPricePerFct;
  const savingsPerFct = profitable 
    ? params.dexPricePerFct - params.miningCostPerFct 
    : 0n;
  
  const savingsPercent = params.dexPricePerFct > 0n
    ? Number((savingsPerFct * 10000n) / params.dexPricePerFct) / 100
    : 0;
  
  return {
    profitable,
    savingsPercent,
    savingsPerFct,
  };
}