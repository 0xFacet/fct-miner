#!/usr/bin/env tsx

import { Command } from "commander";
import { MiningEngine } from "./mining-engine";
import { MiningDatabase } from "./mining-database-json";
import { AutoMiner, MiningStrategy } from "./auto-miner";
import chalk from "chalk";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();

// Parse hours argument (e.g., "2-6,14-18" -> [2,3,4,5,6,14,15,16,17,18])
function parseHours(hoursStr: string): number[] {
  const hours: number[] = [];
  const parts = hoursStr.split(",");
  
  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map(h => parseInt(h.trim()));
      for (let h = start; h <= end; h++) {
        if (h >= 0 && h <= 23) hours.push(h);
      }
    } else {
      const h = parseInt(part.trim());
      if (h >= 0 && h <= 23) hours.push(h);
    }
  }
  
  return [...new Set(hours)].sort((a, b) => a - b);
}

program
  .name("auto-mine")
  .description("FCT Auto-Miner with intelligent thresholds and strategies")
  .version("1.0.0");

program
  .command("start", { isDefault: true })
  .description("Start auto-mining with specified strategy and thresholds")
  .option("-s, --strategy <type>", "Mining strategy (auto|arbitrage)", "auto")
  .option("-c, --max-cost <usd>", "Maximum cost per FCT in USD", parseFloat)
  .option("-e, --min-efficiency <percent>", "Minimum mining efficiency percentage", parseFloat)
  .option("-H, --hours <range>", "Hours to mine (e.g., '2-6,14-18')", parseHours)
  .option("-b, --budget <eth>", "Daily budget in ETH", parseFloat)
  .option("-t, --target <fct>", "Target FCT amount to mine", parseFloat)
  .option("-i, --interval <seconds>", "Check interval in seconds", (v) => parseInt(v) * 1000, 30000)
  .option("-m, --max-size <kb>", "Maximum data size in KB", parseInt, 100)
  .action(async (options) => {
    console.log(chalk.cyan.bold(`
╔═══════════════════════════════════════════════════════════════════════════╗
║                          FCT AUTO-MINER v1.0                             ║
╚═══════════════════════════════════════════════════════════════════════════╝
    `));

    // Validate strategy
    const validStrategies = Object.values(MiningStrategy);
    if (!validStrategies.includes(options.strategy as MiningStrategy)) {
      console.error(chalk.red(`Invalid strategy: ${options.strategy}`));
      console.error(chalk.yellow(`Valid strategies: ${validStrategies.join(", ")}`));
      process.exit(1);
    }

    // Create configuration
    const config = {
      strategy: options.strategy as MiningStrategy,
      maxCostPerFct: options.maxCost,
      minEfficiency: options.minEfficiency,
      scheduleHours: options.hours,
      dailyBudgetEth: options.budget,
      targetFctAmount: options.target,
      checkIntervalMs: options.interval,
      maxDataSizeKb: options.maxSize,
    };

    // Display configuration
    console.log(chalk.cyan("Configuration:"));
    console.log(chalk.white(`  Strategy: ${config.strategy}`));
    if (config.maxCostPerFct) console.log(chalk.white(`  Max cost/FCT: $${config.maxCostPerFct}`));
    if (config.minEfficiency) console.log(chalk.white(`  Min efficiency: ${config.minEfficiency}%`));
    if (config.scheduleHours) console.log(chalk.white(`  Schedule: hours ${config.scheduleHours.join(",")}`));
    if (config.dailyBudgetEth) console.log(chalk.white(`  Daily budget: ${config.dailyBudgetEth} ETH`));
    if (config.targetFctAmount) console.log(chalk.white(`  Target: ${config.targetFctAmount} FCT`));
    console.log(chalk.white(`  Check interval: ${config.checkIntervalMs / 1000}s`));
    console.log(chalk.white(`  Max data size: ${config.maxDataSizeKb}KB`));
    console.log("");

    try {
      // Initialize components
      const engine = new MiningEngine();
      const db = new MiningDatabase();
      const autoMiner = new AutoMiner(engine, db, config);

      // Start mining
      await autoMiner.start();
    } catch (error) {
      console.error(chalk.red("Failed to start auto-miner:"), error);
      process.exit(1);
    }
  });

program
  .command("analyze")
  .description("Analyze mining performance and show statistics")
  .option("-s, --session <id>", "Analyze specific session ID", parseInt)
  .option("-l, --last <n>", "Show last N transactions", parseInt, 10)
  .action(async (options) => {
    try {
      const db = new MiningDatabase();

      console.log(chalk.cyan.bold("\n📊 Mining Analytics\n"));

      // Get stats
      const stats = options.session 
        ? db.getSessionStats(options.session)
        : db.getAllTimeStats();

      if (!stats) {
        console.log(chalk.yellow("No mining data found"));
        db.close();
        return;
      }

      // Display stats
      console.log(chalk.cyan("Performance Summary:"));
      console.log(chalk.white(`  Total transactions: ${stats.txCount}`));
      console.log(chalk.white(`  Total FCT mined: ${stats.totalFctFct.toFixed(2)}`));
      console.log(chalk.white(`  Total ETH spent: ${stats.totalEthEth.toFixed(4)}`));
      console.log(chalk.white(`  Average efficiency: ${stats.avgEfficiency.toFixed(1)}%`));
      console.log(chalk.white(`  Average cost/FCT: $${(stats.avgCostPerFct * 3500).toFixed(5)}`));

      // Best hours
      const bestHours = db.getBestHours(3);
      if (bestHours.length > 0) {
        console.log(chalk.cyan("\nBest Mining Hours:"));
        bestHours.forEach((h, i) => {
          console.log(chalk.white(`  ${i + 1}. Hour ${h.hour}:00 - ${(h.avgFctPerEth * 1000).toFixed(2)} FCT/ETH (${h.txCount} txs)`));
        });
      }

      // Recent transactions
      const recent = db.getRecentTransactions(options.last);
      if (recent.length > 0) {
        console.log(chalk.cyan(`\nLast ${recent.length} Transactions:`));
        recent.forEach((tx) => {
          const time = new Date(tx.timestamp).toLocaleString();
          console.log(chalk.gray(`  ${time}: ${tx.fctMintedFct.toFixed(4)} FCT for ${tx.ethBurnedEth.toFixed(6)} ETH (${tx.efficiency.toFixed(1)}%)`));
        });
      }

      db.close();
    } catch (error) {
      console.error(chalk.red("Failed to analyze:"), error);
      process.exit(1);
    }
  });

program
  .command("profiles")
  .description("Manage mining profiles (predefined configurations)")
  .action(() => {
    console.log(chalk.cyan.bold("\n🎯 Simple Mining Examples\n"));
    
    console.log(chalk.yellow("Basic (Auto mode):"));
    console.log(chalk.gray("  auto-mine --max-cost 0.0005 --budget 0.01"));
    console.log("");
    
    console.log(chalk.yellow("Conservative:"));
    console.log(chalk.gray("  auto-mine --max-cost 0.0003 --budget 0.005"));
    console.log("");
    
    console.log(chalk.yellow("Night Mining:"));
    console.log(chalk.gray("  auto-mine -H 2-6 --budget 0.02"));
    console.log("");
    
    console.log(chalk.yellow("Arbitrage Only:"));
    console.log(chalk.gray("  auto-mine --strategy arbitrage --interval 10"));
    console.log("");
    
    console.log(chalk.yellow("Target Amount:"));
    console.log(chalk.gray("  auto-mine --target 50000 --max-cost 0.0004"));
  });

// Parse command line arguments
program.parse();

// Handle no command
if (!process.argv.slice(2).length) {
  program.outputHelp();
}