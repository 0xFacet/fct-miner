import { formatEther, parseEther } from "viem";
import { calculateFctOutput } from "./fct-calculator";
import { getSwapQuote } from "./facet-swapper";
import { isMainnet } from "./config";
import chalk from "chalk";

// Runtime context for rules
export interface RuntimeContext {
  currentGasPrice: bigint;
  currentBaseFee: bigint;
  currentMintRate: bigint;
  dexSpotPrice: bigint | null;
  sessionSpent: bigint;
  sessionMined: bigint;
  timestamp: Date;
  ethPriceUsd: number;
}

// Rule type - returns true if conditions are met for mining
export type Rule = (ctx: RuntimeContext) => Promise<boolean>;

// Mining strategies
export enum MiningStrategy {
  AUTO = "auto", // Smart mode: maximize efficiency within budget
  ARBITRAGE = "arbitrage", // Only mine when cheaper than DEX
}

// Mining configuration
export interface MiningConfig {
  strategy: MiningStrategy;
  maxCostPerFct?: number; // USD - the main metric that matters
  minEfficiency?: number; // Percentage
  scheduleHours?: number[]; // Hours of day (0-23)
  dailyBudgetEth?: number; // ETH
  targetFctAmount?: number; // FCT
  checkIntervalMs?: number; // Milliseconds
  maxDataSizeKb?: number; // KB
}

// Rule implementations
export const costRule =
  (maxCostUsd: number): Rule =>
  async (ctx) => {
    const costPerFct = calculateCostPerFct(ctx);
    const costUsd = Number(formatEther(costPerFct)) * ctx.ethPriceUsd;
    console.log(
      chalk.gray(
        `  Cost check: $${costUsd.toFixed(5)} <= $${maxCostUsd} ? ${
          costUsd <= maxCostUsd ? "✓" : "✗"
        }`
      )
    );
    return costUsd <= maxCostUsd;
  };

export const efficiencyRule =
  (minEfficiency: number): Rule =>
  async (ctx) => {
    const efficiency = calculateEfficiency(ctx);
    console.log(
      chalk.gray(
        `  Efficiency check: ${efficiency.toFixed(1)}% >= ${minEfficiency}% ? ${
          efficiency >= minEfficiency ? "✓" : "✗"
        }`
      )
    );
    return efficiency >= minEfficiency;
  };

export const scheduleRule =
  (hours: number[]): Rule =>
  async (ctx) => {
    const currentHour = ctx.timestamp.getHours();
    const inSchedule = hours.includes(currentHour);
    console.log(
      chalk.gray(
        `  Schedule check: hour ${currentHour} in [${hours.join(",")}] ? ${
          inSchedule ? "✓" : "✗"
        }`
      )
    );
    return inSchedule;
  };

export const budgetRule =
  (maxEth: number): Rule =>
  async (ctx) => {
    const spentEth = Number(formatEther(ctx.sessionSpent));
    const underBudget = spentEth < maxEth;
    console.log(
      chalk.gray(
        `  Budget check: ${spentEth.toFixed(4)} ETH < ${maxEth} ETH ? ${
          underBudget ? "✓" : "✗"
        }`
      )
    );
    return underBudget;
  };

export const targetRule =
  (targetFct: number): Rule =>
  async (ctx) => {
    const minedFct = Number(formatEther(ctx.sessionMined));
    const needMore = minedFct < targetFct;
    console.log(
      chalk.gray(
        `  Target check: ${minedFct.toFixed(2)} FCT < ${targetFct} FCT ? ${
          needMore ? "✓" : "✗"
        }`
      )
    );
    return needMore;
  };

export const arbitrageRule = (): Rule => async (ctx) => {
  if (!ctx.dexSpotPrice || !isMainnet()) return false;
  const miningCost = calculateCostPerFct(ctx);
  const profitable = miningCost < ctx.dexSpotPrice;
  if (!profitable) {
    console.log(chalk.gray(`  Arbitrage check: mining >= DEX price ✗`));
    return false;
  }

  // Fix BigInt math - convert to Number after division
  const savingsPct =
    Number(((ctx.dexSpotPrice - miningCost) * 10000n) / ctx.dexSpotPrice) / 100;
  console.log(
    chalk.gray(`  Arbitrage check: mining < DEX by ${savingsPct.toFixed(2)}% ✓`)
  );
  return true;
};

// Helper functions
function calculateCostPerFct(ctx: RuntimeContext): bigint {
  const dataSize = 50 * 1024; // Default 50KB for estimation
  const calc = calculateFctOutput({
    dataSize,
    baseFee: ctx.currentBaseFee,
    mintRate: ctx.currentMintRate,
    gasPrice: ctx.currentGasPrice, // Use actual gas price for cost estimation
  });
  return calc.costPerFct;
}

function calculateEfficiency(ctx: RuntimeContext): number {
  const dataSize = 50 * 1024;
  const calc = calculateFctOutput({
    dataSize,
    baseFee: ctx.currentBaseFee,
    mintRate: ctx.currentMintRate,
  });
  return calc.efficiency;
}

// Build rules from configuration
export function buildRulesFromConfig(config: MiningConfig): Rule[] {
  const rules: Rule[] = [];

  // Add rules based on config
  if (config.maxCostPerFct !== undefined) {
    rules.push(costRule(config.maxCostPerFct));
  }
  if (config.minEfficiency !== undefined) {
    rules.push(efficiencyRule(config.minEfficiency));
  }
  if (config.scheduleHours && config.scheduleHours.length > 0) {
    rules.push(scheduleRule(config.scheduleHours));
  }
  if (config.dailyBudgetEth !== undefined) {
    rules.push(budgetRule(config.dailyBudgetEth));
  }
  if (config.targetFctAmount !== undefined) {
    rules.push(targetRule(config.targetFctAmount));
  }
  if (config.strategy === MiningStrategy.ARBITRAGE) {
    rules.push(arbitrageRule());
  }

  return rules;
}

// Evaluate all rules
export async function evaluateRules(
  rules: Rule[],
  ctx: RuntimeContext
): Promise<boolean> {
  if (rules.length === 0) return true;

  console.log(chalk.gray("Evaluating rules:"));
  const results = await Promise.all(rules.map((rule) => rule(ctx)));
  return results.every((result) => result === true);
}

// Get optimal data size based on strategy and constraints
export function getOptimalDataSize(
  strategy: MiningStrategy,
  ctx: RuntimeContext,
  maxKb: number,
  remainingBudget?: bigint
): number {
  const KB = 1024;
  const maxSize = maxKb * KB;

  // If we have a budget, calculate max data size we can afford
  if (remainingBudget && remainingBudget > 0n) {
    // Estimate cost for max size
    const testCalc = calculateFctOutput({
      dataSize: maxSize,
      baseFee: ctx.currentBaseFee,
      mintRate: ctx.currentMintRate,
      gasPrice: ctx.currentGasPrice,
    });

    // If max size is too expensive, scale down
    if (testCalc.ethBurned > remainingBudget) {
      // Binary search for optimal size that fits budget
      let low = 1 * KB;
      let high = maxSize;
      let optimal = low;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const calc = calculateFctOutput({
          dataSize: mid,
          baseFee: ctx.currentBaseFee,
          mintRate: ctx.currentMintRate,
          gasPrice: ctx.currentGasPrice,
        });

        if (calc.ethBurned <= remainingBudget) {
          optimal = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      console.log(
        chalk.yellow(
          `  Budget limit: using ${(optimal / KB).toFixed(
            1
          )}KB to fit remaining budget`
        )
      );
      return optimal;
    }
  }

  // Strategy logic simplified
  switch (strategy) {
    case MiningStrategy.AUTO:
      // Always maximize efficiency - use the biggest size possible
      return maxSize;

    case MiningStrategy.ARBITRAGE:
      // Only mine if cheaper than DEX
      if (!ctx.dexSpotPrice) return 0;
      const miningCost = calculateCostPerFct(ctx);
      return miningCost < ctx.dexSpotPrice ? maxSize : 0;

    default:
      return maxSize;
  }
}

// Get ETH price from API
export async function getEthPriceUsd(): Promise<number> {
  try {
    const response = await fetch("https://eth-price.facet.org");
    const data = await response.json();
    return parseFloat(data.priceInUSD) || 3500;
  } catch {
    return 3500;
  }
}

// Collect runtime context for rule evaluation
export async function collectRuntimeContext(
  sessionSpent: bigint,
  sessionMined: bigint,
  currentGasPrice: bigint,
  currentBaseFee: bigint,
  currentMintRate: bigint,
  ethPriceUsd: number
): Promise<RuntimeContext> {
  let dexSpotPrice: bigint | null = null;
  if (isMainnet()) {
    const quote = await getSwapQuote(parseEther("1"));
    dexSpotPrice = quote ? quote.spotPrice : null;
  }

  return {
    currentGasPrice,
    currentBaseFee,
    currentMintRate,
    dexSpotPrice,
    sessionSpent,
    sessionMined,
    timestamp: new Date(),
    ethPriceUsd,
  };
}
