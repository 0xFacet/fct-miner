import chalk from "chalk";
import { createSpinner } from "nanospinner";
import { formatEther } from "viem";
import { getNetworkConfig } from "./config.js";
import { readFileSync } from "fs";
import { join } from "path";
import { MiningConfig } from "./mining-rules";

// Get version from package.json
function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, "package.json"), "utf8")
  );
  return packageJson.version;
}

const VERSION = getVersion();

interface MiningStats {
  totalTransactions: number;
  totalETHSpent: bigint;
  totalFCTMinted: bigint;
  remainingBudget: bigint;
  sessionTarget: bigint;
  currentBalance: bigint;
  ethPrice: number;
  avgCostPerFCT: number;
  estimatedTimeLeft: string;
  miningRate: number; // FCT per hour
}

interface TransactionProgress {
  current: number;
  total: number;
  status: "preparing" | "submitting" | "confirming" | "completed" | "failed";
  ethCost: bigint;
  fctMinted: bigint;
  hash?: string;
}

export class MiningDashboard {
  private stats: MiningStats;
  private currentTx: TransactionProgress | null = null;
  private startTime: number = Date.now();
  private intervalId: NodeJS.Timeout | null = null;
  private miningConfig?: MiningConfig;

  constructor(initialStats: Partial<MiningStats>, miningConfig?: MiningConfig) {
    this.miningConfig = miningConfig;
    this.stats = {
      totalTransactions: 0,
      totalETHSpent: 0n,
      totalFCTMinted: 0n,
      remainingBudget: 0n,
      sessionTarget: 0n,
      currentBalance: 0n,
      ethPrice: 0,
      avgCostPerFCT: 0,
      estimatedTimeLeft: "calculating...",
      miningRate: 0,
      ...initialStats,
    };
  }

  start() {
    this.render();
    this.startLiveUpdates();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  updateStats(newStats: Partial<MiningStats>) {
    this.stats = { ...this.stats, ...newStats };
    this.calculateDerivedStats();
  }

  startTransaction(txData: Omit<TransactionProgress, "current" | "total">) {
    this.currentTx = {
      current: this.stats.totalTransactions + 1,
      total: Math.ceil(
        Number(this.stats.sessionTarget) / Number(txData.ethCost)
      ),
      ...txData,
    };
  }

  updateTransaction(updates: Partial<TransactionProgress>) {
    if (this.currentTx) {
      this.currentTx = { ...this.currentTx, ...updates };
    }
  }

  completeTransaction(ethSpent: bigint, fctMinted: bigint) {
    this.stats.totalTransactions++;
    this.stats.totalETHSpent += ethSpent;
    this.stats.totalFCTMinted += fctMinted;
    this.stats.remainingBudget -= ethSpent;
    this.stats.currentBalance -= ethSpent;
    this.currentTx = null;
    this.calculateDerivedStats();
  }

  private calculateDerivedStats() {
    const elapsedHours = (Date.now() - this.startTime) / (1000 * 60 * 60);
    this.stats.miningRate =
      elapsedHours > 0
        ? Number(formatEther(this.stats.totalFCTMinted)) / elapsedHours
        : 0;

    if (this.stats.totalFCTMinted > 0n) {
      const totalSpentUSD =
        Number(formatEther(this.stats.totalETHSpent)) * this.stats.ethPrice;
      this.stats.avgCostPerFCT =
        totalSpentUSD / Number(formatEther(this.stats.totalFCTMinted));
    }

    // Estimate time left based on current rate
    if (this.stats.miningRate > 0 && this.stats.remainingBudget > 0n) {
      const remainingETH = Number(formatEther(this.stats.remainingBudget));
      const estimatedETHPerHour =
        Number(formatEther(this.stats.totalETHSpent)) / elapsedHours;
      const hoursLeft =
        estimatedETHPerHour > 0 ? remainingETH / estimatedETHPerHour : 0;

      if (hoursLeft < 1) {
        this.stats.estimatedTimeLeft = `${Math.round(hoursLeft * 60)}m`;
      } else {
        this.stats.estimatedTimeLeft = `${Math.round(hoursLeft)}h ${Math.round(
          (hoursLeft % 1) * 60
        )}m`;
      }
    }
  }

  private startLiveUpdates() {
    this.intervalId = setInterval(() => {
      this.calculateDerivedStats();
      this.render();
    }, 1000);
  }

  private render() {
    console.clear();
    this.renderHeader();
    this.renderProgress();
    this.renderStats();
    this.renderCurrentTransaction();
    this.renderFooter();
  }

  private renderHeader() {
    const borderWidth = 79;
    const text = `FCT MINER v${VERSION}`;
    const padding = Math.floor((borderWidth - text.length) / 2);
    const remainder = borderWidth - text.length - padding;
    const centeredText = " ".repeat(padding) + text + " ".repeat(remainder);

    console.log(chalk.hex("#00FF00")("╔" + "═".repeat(borderWidth) + "╗"));
    console.log(
      chalk.hex("#00FF00")("║") +
        chalk.hex("#00FF88").bold(centeredText) +
        chalk.hex("#00FF00")("║")
    );
    console.log(chalk.hex("#00FF00")("╚" + "═".repeat(borderWidth) + "╝"));
  }

  private renderProgress() {
    const progressWidth = 60;
    const spent = Number(formatEther(this.stats.totalETHSpent));
    const target = Number(formatEther(this.stats.sessionTarget));
    const progress = target > 0 ? Math.min(spent / target, 1) : 0;

    const filled = Math.round(progress * progressWidth);
    const empty = progressWidth - filled;
    const bar = "█".repeat(filled) + "░".repeat(empty);
    const percentage = Math.round(progress * 100);

    console.log(
      `\n${chalk.cyan("Progress:")} ${chalk.yellow(percentage + "%")}`
    );
    console.log(`${chalk.green(bar)}`);
    console.log(
      `${chalk.white(
        formatEther(this.stats.totalETHSpent).slice(0, 8)
      )} / ${chalk.white(
        formatEther(this.stats.sessionTarget).slice(0, 8)
      )} ETH`
    );
  }

  private renderStats() {
    console.log(`\n${chalk.cyan("Mining Stats:")}`);

    console.log(
      `  Transactions: ${chalk.green.bold(this.stats.totalTransactions)}`
    );
    console.log(
      `  Balance: ${chalk.yellow.bold(
        formatEther(this.stats.currentBalance).slice(0, 8)
      )} ETH`
    );
    console.log(
      `  ETH Spent: ${chalk.red.bold(
        formatEther(this.stats.totalETHSpent).slice(0, 8)
      )} ETH`
    );
    console.log(
      `  ETH Price: ${chalk.green.bold("$" + this.stats.ethPrice.toFixed(0))}`
    );
    console.log(
      `  FCT Mined: ${chalk.magenta.bold(
        formatEther(this.stats.totalFCTMinted).slice(0, 8)
      )} FCT`
    );
    console.log(
      `  Avg Cost: ${chalk.yellow.bold(
        "$" + this.stats.avgCostPerFCT.toFixed(3) + "/FCT"
      )}`
    );
    console.log(
      `  Rate: ${chalk.cyan.bold(this.stats.miningRate.toFixed(1) + " FCT/hr")}`
    );
    console.log(`  ETA: ${chalk.blue.bold(this.stats.estimatedTimeLeft)}`);

    // Display mining configuration if available
    if (this.miningConfig) {
      const hasAdvancedRules =
        this.miningConfig.maxCostPerFct ||
        this.miningConfig.minEfficiency ||
        this.miningConfig.scheduleHours ||
        this.miningConfig.targetFctAmount;

      if (hasAdvancedRules) {
        console.log(`\n${chalk.cyan("Mining Rules:")}`);

        if (this.miningConfig.maxCostPerFct) {
          console.log(
            `  Max Cost: ${chalk.green.bold(
              "$" + this.miningConfig.maxCostPerFct + "/FCT"
            )}`
          );
        }

        if (this.miningConfig.minEfficiency) {
          console.log(
            `  Min Efficiency: ${chalk.green.bold(
              this.miningConfig.minEfficiency + "%"
            )}`
          );
        }

        if (this.miningConfig.scheduleHours) {
          console.log(
            `  Schedule: ${chalk.blue.bold(
              "Hours " + this.miningConfig.scheduleHours.join(",")
            )}`
          );
        }

        if (this.miningConfig.targetFctAmount) {
          console.log(
            `  Target: ${chalk.magenta.bold(
              this.miningConfig.targetFctAmount + " FCT"
            )}`
          );
        }
      }
    }
  }

  private renderCurrentTransaction() {
    if (!this.currentTx) {
      console.log(`\n${chalk.gray("Waiting for next transaction...")}`);
      return;
    }

    const statusColors = {
      preparing: chalk.blue,
      submitting: chalk.yellow,
      confirming: chalk.magenta,
      completed: chalk.green,
      failed: chalk.red,
    };

    const statusTexts = {
      preparing: "Preparing",
      submitting: "Submitting",
      confirming: "Confirming",
      completed: "Completed",
      failed: "Failed",
    };

    console.log(`\n${chalk.cyan("Transaction #" + this.currentTx.current)}`);
    console.log(
      `  Status: ${statusColors[this.currentTx.status](
        statusTexts[this.currentTx.status]
      )}`
    );

    if (this.currentTx.hash) {
      const networkConfig = getNetworkConfig();
      const explorerUrl = `${networkConfig.facetChain.blockExplorers.default.url}/tx/${this.currentTx.hash}`;
      const shortHash =
        this.currentTx.hash.slice(0, 10) +
        "..." +
        this.currentTx.hash.slice(-8);

      // Make the hash clickable with OSC 8 escape sequences for modern terminals
      const clickableHash = `\u001b]8;;${explorerUrl}\u001b\\${chalk.blue(
        shortHash
      )}\u001b]8;;\u001b\\`;
      console.log(`  Hash: ${clickableHash}`);
    }

    if (
      this.currentTx.status === "completed" &&
      this.currentTx.fctMinted > 0n
    ) {
      console.log(
        `  FCT Mined: ${chalk.green.bold(
          formatEther(this.currentTx.fctMinted).slice(0, 8)
        )} FCT`
      );
    }
  }

  private renderFooter() {
    const runtime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(runtime / 3600);
    const minutes = Math.floor((runtime % 3600) / 60);
    const seconds = runtime % 60;

    const uptime = `${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

    console.log(
      `\n${chalk.gray("Uptime:")} ${chalk.cyan(uptime)} | ${chalk.gray(
        "Press Ctrl+C to stop"
      )}`
    );
  }

  // Animation helpers
  showMiningAnimation() {
    const frames = ["◐", "◓", "◑", "◒"];
    let frameIndex = 0;

    return setInterval(() => {
      process.stdout.write(
        `\r${chalk.cyan(frames[frameIndex])} ${chalk.red(
          "BREACH_IN_PROGRESS"
        )}... `
      );
      frameIndex = (frameIndex + 1) % frames.length;
    }, 150);
  }

  showCountdown(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      let remaining = seconds;
      const countdownInterval = setInterval(() => {
        if (remaining <= 0) {
          clearInterval(countdownInterval);
          process.stdout.write(`\r${" ".repeat(50)}\r`);
          resolve();
          return;
        }

        process.stdout.write(
          `\r${chalk.cyan("Next transaction in:")} ${chalk.yellow.bold(
            remaining
          )}s`
        );
        remaining--;
      }, 1000);
    });
  }
}
