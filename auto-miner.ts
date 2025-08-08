#!/usr/bin/env tsx

import { formatEther, parseEther } from "viem";
import { MiningEngine, type MiningResult } from "./mining-engine";
import { MiningDatabase } from "./mining-database-json";
import { calculateFctOutput } from "./fct-calculator";
import { getSwapQuote } from "./facet-swapper";
import { isMainnet } from "./config";
import chalk from "chalk";
import * as dotenv from "dotenv";

dotenv.config();

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

// Mining strategies (simplified!)
export enum MiningStrategy {
  AUTO = "auto",              // Smart mode: maximize efficiency within budget
  ARBITRAGE = "arbitrage",    // Only mine when cheaper than DEX
}

// Auto-miner configuration
export interface AutoMinerConfig {
  strategy: MiningStrategy;
  maxCostPerFct?: number;      // USD - the main metric that matters
  minEfficiency?: number;      // Percentage
  scheduleHours?: number[];    // Hours of day (0-23)
  dailyBudgetEth?: number;     // ETH
  targetFctAmount?: number;    // FCT
  checkIntervalMs?: number;    // Milliseconds
  maxDataSizeKb?: number;      // KB
}

// Rule implementations
export const costRule = (maxCostUsd: number): Rule =>
  async (ctx) => {
    const costPerFct = calculateCostPerFct(ctx);
    const costUsd = Number(formatEther(costPerFct)) * ctx.ethPriceUsd;
    console.log(chalk.gray(`  Cost check: $${costUsd.toFixed(5)} <= $${maxCostUsd} ? ${costUsd <= maxCostUsd ? '✓' : '✗'}`));
    return costUsd <= maxCostUsd;
  };

// Removed gasRule - gas price doesn't matter for FCT mining profitability

export const efficiencyRule = (minEfficiency: number): Rule =>
  async (ctx) => {
    const efficiency = calculateEfficiency(ctx);
    console.log(chalk.gray(`  Efficiency check: ${efficiency.toFixed(1)}% >= ${minEfficiency}% ? ${efficiency >= minEfficiency ? '✓' : '✗'}`));
    return efficiency >= minEfficiency;
  };

export const scheduleRule = (hours: number[]): Rule =>
  async (ctx) => {
    const currentHour = ctx.timestamp.getHours();
    const inSchedule = hours.includes(currentHour);
    console.log(chalk.gray(`  Schedule check: hour ${currentHour} in [${hours.join(',')}] ? ${inSchedule ? '✓' : '✗'}`));
    return inSchedule;
  };

export const budgetRule = (maxEth: number): Rule =>
  async (ctx) => {
    const spentEth = Number(formatEther(ctx.sessionSpent));
    const underBudget = spentEth < maxEth;
    console.log(chalk.gray(`  Budget check: ${spentEth.toFixed(4)} ETH < ${maxEth} ETH ? ${underBudget ? '✓' : '✗'}`));
    return underBudget;
  };

export const targetRule = (targetFct: number): Rule =>
  async (ctx) => {
    const minedFct = Number(formatEther(ctx.sessionMined));
    const needMore = minedFct < targetFct;
    console.log(chalk.gray(`  Target check: ${minedFct.toFixed(2)} FCT < ${targetFct} FCT ? ${needMore ? '✓' : '✗'}`));
    return needMore;
  };

export const arbitrageRule = (): Rule =>
  async (ctx) => {
    if (!ctx.dexSpotPrice || !isMainnet()) return false;
    const miningCost = calculateCostPerFct(ctx);
    const profitable = miningCost < ctx.dexSpotPrice;
    if (!profitable) {
      console.log(chalk.gray(`  Arbitrage check: mining >= DEX price ✗`));
      return false;
    }
    
    // Fix BigInt math - convert to Number after division
    const savingsPct = Number((ctx.dexSpotPrice - miningCost) * 10000n / ctx.dexSpotPrice) / 100;
    console.log(chalk.gray(`  Arbitrage check: mining < DEX by ${savingsPct.toFixed(2)}% ✓`));
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

async function getEthPriceUsd(): Promise<number> {
  try {
    const response = await fetch("https://eth-price.facet.org");
    const data = await response.json();
    return parseFloat(data.priceInUSD) || 3500;
  } catch {
    return 3500;
  }
}

function getOptimalDataSize(strategy: MiningStrategy, ctx: RuntimeContext, maxKb: number, remainingBudget?: bigint): number {
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
      
      console.log(chalk.yellow(`  Budget limit: using ${(optimal / KB).toFixed(1)}KB to fit remaining budget`));
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

export class AutoMiner {
  private rules: Rule[] = [];
  private running = false;
  private sessionId: number = 0;
  private sessionSpent = 0n;
  private sessionMined = 0n;

  constructor(
    private engine: MiningEngine,
    private db: MiningDatabase,
    private config: AutoMinerConfig
  ) {
    this.setupRules();
  }

  private setupRules() {
    // Add rules based on config
    if (this.config.maxCostPerFct !== undefined) {
      this.rules.push(costRule(this.config.maxCostPerFct));
    }
    // REMOVED gas check - higher gas = more FCT per transaction, which is good!
    // We only care about cost per FCT in USD
    if (this.config.minEfficiency !== undefined) {
      this.rules.push(efficiencyRule(this.config.minEfficiency));
    }
    if (this.config.scheduleHours && this.config.scheduleHours.length > 0) {
      this.rules.push(scheduleRule(this.config.scheduleHours));
    }
    if (this.config.dailyBudgetEth !== undefined) {
      this.rules.push(budgetRule(this.config.dailyBudgetEth));
    }
    if (this.config.targetFctAmount !== undefined) {
      this.rules.push(targetRule(this.config.targetFctAmount));
    }
    if (this.config.strategy === MiningStrategy.ARBITRAGE) {
      this.rules.push(arbitrageRule());
    }
  }

  async start() {
    console.log(chalk.cyan("\n🚀 Starting Auto-Miner"));
    console.log(chalk.yellow(`Strategy: ${this.config.strategy}`));
    console.log(chalk.yellow(`Check interval: ${(this.config.checkIntervalMs || 30000) / 1000}s`));
    
    this.running = true;
    this.sessionId = this.db.createSession(this.config.strategy);
    
    // Restore session state if recovering from crash
    const savedSpent = this.db.getRuntimeState(`session_${this.sessionId}_spent`);
    const savedMined = this.db.getRuntimeState(`session_${this.sessionId}_mined`);
    if (savedSpent) this.sessionSpent = BigInt(savedSpent);
    if (savedMined) this.sessionMined = BigInt(savedMined);
    
    // Set up graceful shutdown
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
    
    while (this.running) {
      try {
        await this.miningCycle();
      } catch (error) {
        console.error(chalk.red("Mining cycle error:"), error);
        // Continue running unless explicitly stopped
      }
      
      if (this.running) {
        const interval = this.config.checkIntervalMs || 30000;
        console.log(chalk.gray(`Next check in ${interval / 1000}s...`));
        await this.sleep(interval);
      }
    }
  }

  private async miningCycle() {
    console.log(chalk.cyan(`\n⏰ [${new Date().toLocaleTimeString()}] Checking conditions...`));
    
    const ctx = await this.collectContext();
    const shouldMine = await this.evaluateRules(ctx);
    
    if (!shouldMine) {
      console.log(chalk.yellow("Conditions not met, waiting..."));
      return;
    }
    
    console.log(chalk.green("✓ All conditions met! Starting mining..."));
    
    // Calculate remaining budget if we have one
    let remainingBudget: bigint | undefined;
    if (this.config.dailyBudgetEth) {
      const budgetWei = BigInt(Math.floor(this.config.dailyBudgetEth * 1e18));
      remainingBudget = budgetWei - this.sessionSpent;
    }
    
    const dataSize = getOptimalDataSize(
      this.config.strategy,
      ctx,
      this.config.maxDataSizeKb || 100,
      remainingBudget
    );
    
    // Guard against zero-byte transactions
    if (dataSize === 0) {
      console.log(chalk.yellow("Data size is 0 - skipping mining this cycle (likely arbitrage not favorable)"));
      return;
    }
    
    console.log(chalk.cyan(`Mining with ${(dataSize / 1024).toFixed(1)}KB data...`));
    
    const result = await this.engine.mine({
      dataSize,
      gasMultiplier: 1.5,
      maxRetries: 3,
      escalateGas: true,
    });
    
    // Update session totals
    this.sessionSpent += result.ethBurned;
    this.sessionMined += result.fctMinted;
    
    // Save to database
    this.db.saveTransaction(result, this.sessionId);
    this.db.saveRuntimeState(`session_${this.sessionId}_spent`, this.sessionSpent.toString());
    this.db.saveRuntimeState(`session_${this.sessionId}_mined`, this.sessionMined.toString());
    
    // Display results
    this.displayResult(result, ctx);
    
    // Check if targets reached
    if (this.config.dailyBudgetEth && Number(formatEther(this.sessionSpent)) >= this.config.dailyBudgetEth) {
      console.log(chalk.yellow("\n💰 Daily budget reached!"));
      await this.stop();
    }
    
    if (this.config.targetFctAmount && Number(formatEther(this.sessionMined)) >= this.config.targetFctAmount) {
      console.log(chalk.green("\n🎯 Target FCT amount reached!"));
      await this.stop();
    }
  }

  private async collectContext(): Promise<RuntimeContext> {
    const conditions = await this.engine.getNetworkConditions();
    const ethPriceUsd = await getEthPriceUsd();
    
    let dexSpotPrice: bigint | null = null;
    if (isMainnet()) {
      const quote = await getSwapQuote(parseEther("1"));
      dexSpotPrice = quote ? quote.spotPrice : null;
    }
    
    return {
      currentGasPrice: conditions.gasPrice,
      currentBaseFee: conditions.baseFee,
      currentMintRate: conditions.mintRate,
      dexSpotPrice,
      sessionSpent: this.sessionSpent,
      sessionMined: this.sessionMined,
      timestamp: conditions.timestamp,
      ethPriceUsd,
    };
  }

  private async evaluateRules(ctx: RuntimeContext): Promise<boolean> {
    if (this.rules.length === 0) return true;
    
    console.log(chalk.gray("Evaluating rules:"));
    const results = await Promise.all(this.rules.map(rule => rule(ctx)));
    return results.every(result => result === true);
  }

  private displayResult(result: MiningResult, ctx: RuntimeContext) {
    const ethSpent = Number(formatEther(result.ethBurned));
    const fctMinted = Number(formatEther(result.fctMinted));
    const costPerFct = ethSpent / fctMinted;
    const costPerFctUsd = costPerFct * ctx.ethPriceUsd;
    
    console.log(chalk.green("\n✅ Mining successful!"));
    console.log(chalk.white(`  FCT minted: ${fctMinted.toFixed(4)}`));
    console.log(chalk.white(`  ETH spent: ${ethSpent.toFixed(6)}`));
    console.log(chalk.white(`  Cost/FCT: $${costPerFctUsd.toFixed(5)}`));
    console.log(chalk.white(`  Efficiency: ${result.efficiency.toFixed(1)}%`));
    console.log(chalk.gray(`  L1: ${result.l1Hash}`));
    console.log(chalk.gray(`  Facet: ${result.facetHash}`));
    
    // Session totals
    const sessionEth = Number(formatEther(this.sessionSpent));
    const sessionFct = Number(formatEther(this.sessionMined));
    const sessionAvgCost = sessionEth / sessionFct;
    
    console.log(chalk.cyan("\n📊 Session totals:"));
    console.log(chalk.white(`  Total FCT: ${sessionFct.toFixed(2)}`));
    console.log(chalk.white(`  Total ETH: ${sessionEth.toFixed(4)}`));
    console.log(chalk.white(`  Avg cost: $${(sessionAvgCost * ctx.ethPriceUsd).toFixed(5)}`));
  }

  async stop() {
    if (!this.running) return;
    
    console.log(chalk.yellow("\n🛑 Stopping Auto-Miner..."));
    this.running = false;
    
    // End session in database
    if (this.sessionId) {
      this.db.endSession(this.sessionId);
      
      // Display final stats
      const stats = this.db.getSessionStats(this.sessionId);
      if (stats) {
        console.log(chalk.cyan("\n📈 Final session stats:"));
        console.log(chalk.white(`  Transactions: ${stats.txCount}`));
        console.log(chalk.white(`  Total FCT: ${stats.totalFctFct.toFixed(2)}`));
        console.log(chalk.white(`  Total ETH: ${stats.totalEthEth.toFixed(4)}`));
        console.log(chalk.white(`  Avg efficiency: ${stats.avgEfficiency.toFixed(1)}%`));
        console.log(chalk.white(`  Avg cost/FCT: $${(stats.avgCostPerFct * 3500).toFixed(5)}`));
      }
    }
    
    console.log(chalk.green("\n✨ Auto-Miner stopped successfully"));
    process.exit(0);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}