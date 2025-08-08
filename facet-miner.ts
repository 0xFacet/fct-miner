#!/usr/bin/env tsx
import { Command } from "commander";
import {
  createWalletClient,
  createPublicClient,
  http,
  formatEther,
  formatGwei,
  toBytes,
  toHex,
  maxUint256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as dotenv from "dotenv";
import * as readline from "readline";
import {
  calculateInputGasCost,
  computeFacetTransactionHash,
  getFctMintRate,
  sendRawFacetTransaction,
} from "@0xfacet/sdk/utils";
import { FACET_INBOX_ADDRESS } from "@0xfacet/sdk/constants";
import { compareMiningVsSwapping, getSwapQuote } from "./facet-swapper";
import { getNetworkConfig, getCurrentNetwork, isMainnet } from "./config";
import ui from "./enhanced-ui";
import { MiningDashboard } from "./mining-dashboard";
import { MiningDatabase } from "./mining-database-json";
import { AnalyticsEngine } from "./analytics-engine";
import { calculateFctOutput } from "./fct-calculator";
import {
  buildRulesFromConfig,
  evaluateRules,
  collectRuntimeContext,
  getEthPriceUsd,
  MiningStrategy,
  MiningConfig,
  type RuntimeContext,
} from "./mining-rules";
import chalk from "chalk";
import { readFileSync } from "fs";
import { join } from "path";

dotenv.config();

// Get version from package.json
function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, "package.json"), "utf8")
  );
  return packageJson.version;
}

const VERSION = getVersion();

// Get network configuration
const networkConfig = getNetworkConfig();

// Helper function to prompt user for input
function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// Parse hours argument (e.g., "2-6,14-18" -> [2,3,4,5,6,14,15,16,17,18])
function parseHours(hoursStr: string): number[] {
  const hours: number[] = [];
  const parts = hoursStr.split(",");

  for (const part of parts) {
    if (part.includes("-")) {
      const [start, end] = part.split("-").map((h) => parseInt(h.trim()));
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

// Command line interface setup
const program = new Command();

program
  .name("facet-miner")
  .description("FCT Miner with interactive and advanced mining features")
  .version(VERSION)
  .option("-s, --strategy <type>", "Mining strategy (auto|arbitrage)", "auto")
  .option("-c, --max-cost-usd <usd>", "Maximum cost per FCT in USD", parseFloat)
  .option(
    "-e, --min-efficiency <percent>",
    "Minimum mining efficiency percentage",
    parseFloat
  )
  .option(
    "-H, --hours <range>",
    "Hours to mine (e.g., '2-6,14-18')",
    parseHours
  )
  .option("-b, --budget <eth>", "Daily budget in ETH", parseFloat)
  .option("-t, --target <fct>", "Target FCT amount to mine", parseFloat)
  .option(
    "-i, --interval <seconds>",
    "Check interval in seconds (enables smart polling mode)",
    (v) => parseInt(v) * 1000
  )
  .option("-m, --max-size <kb>", "Maximum data size in KB", parseInt)
  .option("--analyze", "Show analytics after completion")
  .option("--profiles", "Show mining profile examples")
  .action(async (options) => {
    // Handle special commands first
    if (options.profiles) {
      showProfiles();
      return;
    }

    if (options.analyze) {
      await showAnalytics();
      return;
    }

    // Always use interactive mining with enhanced dashboard
    await startInteractiveMining(options);
  });

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY not found in .env file");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

// FCT max supply in wei
const FCT_MAX_SUPPLY = 1646951661163841381479607357n;

const publicClient = createPublicClient({
  chain: networkConfig.l1Chain,
  transport: http(networkConfig.l1RpcUrl),
});

// Get Facet chain configuration from network config
const facetChain = networkConfig.facetChain;

const facetClient = createPublicClient({
  chain: facetChain,
  transport: http(networkConfig.facetRpcUrl),
});

const walletClient = createWalletClient({
  account,
  chain: networkConfig.l1Chain,
  transport: http(networkConfig.l1RpcUrl),
});

// Show profiles function
function showProfiles() {
  console.log(chalk.cyan.bold("\n>> Mining Profile Examples\n"));

  console.log(chalk.yellow("Basic (Smart mode):"));
  console.log(chalk.gray("  pnpm mine --max-cost-usd 0.0005 --budget 0.01"));
  console.log("");

  console.log(chalk.yellow("Conservative:"));
  console.log(chalk.gray("  pnpm mine --max-cost-usd 0.0003 --budget 0.005"));
  console.log("");

  console.log(chalk.yellow("Night Mining (Scheduled):"));
  console.log(chalk.gray("  pnpm mine --hours 2-6 --budget 0.02"));
  console.log("");

  console.log(chalk.yellow("Arbitrage Only (Smart):"));
  console.log(chalk.gray("  pnpm mine --strategy arbitrage --interval 10"));
  console.log("");

  console.log(chalk.yellow("Target Amount:"));
  console.log(chalk.gray("  pnpm mine --target 50000 --max-cost-usd 0.0004"));
  console.log("");

  console.log(chalk.yellow("Interactive with Budget Override:"));
  console.log(
    chalk.gray("  pnpm mine --budget 0.01  # Skips spending cap prompt")
  );
  console.log("");

  console.log(chalk.yellow("Interactive with Size Override:"));
  console.log(
    chalk.gray("  pnpm mine --max-size 50  # Skips size selection prompt")
  );
}

// Show analytics function
async function showAnalytics() {
  try {
    const db = new MiningDatabase();
    console.log(chalk.cyan.bold("\n📊 Mining Analytics\n"));

    const stats = db.getAllTimeStats();
    if (!stats) {
      console.log(chalk.yellow("No mining data found"));
      db.close();
      return;
    }

    // Display stats
    console.log(chalk.cyan("Performance Summary:"));
    console.log(chalk.white(`  Total transactions: ${stats.txCount}`));
    console.log(
      chalk.white(`  Total FCT mined: ${stats.totalFctFct.toFixed(2)}`)
    );
    console.log(
      chalk.white(`  Total ETH spent: ${stats.totalEthEth.toFixed(4)}`)
    );
    console.log(
      chalk.white(`  Average efficiency: ${stats.avgEfficiency.toFixed(1)}%`)
    );
    console.log(
      chalk.white(
        `  Average cost/FCT: $${(stats.avgCostPerFct * 3500).toFixed(5)}`
      )
    );

    // Best hours
    const bestHours = db.getBestHours(3);
    if (bestHours.length > 0) {
      console.log(chalk.cyan("\nBest Mining Hours:"));
      bestHours.forEach((h, i) => {
        console.log(
          chalk.white(
            `  ${i + 1}. Hour ${h.hour}:00 - ${(h.avgFctPerEth * 1000).toFixed(
              2
            )} FCT/ETH (${h.txCount} txs)`
          )
        );
      });
    }

    // Recent transactions
    const recent = db.getRecentTransactions(10);
    if (recent.length > 0) {
      console.log(chalk.cyan(`\nLast ${recent.length} Transactions:`));
      recent.forEach((tx) => {
        const time = new Date(tx.timestamp).toLocaleString();
        console.log(
          chalk.gray(
            `  ${time}: ${tx.fctMintedFct.toFixed(
              4
            )} FCT for ${tx.ethBurnedEth.toFixed(
              6
            )} ETH (${tx.efficiency.toFixed(1)}%)`
          )
        );
      });
    }

    db.close();
  } catch (error) {
    console.error(chalk.red("Failed to analyze:"), error);
    process.exit(1);
  }
}

// Uniswap V2 pairs (mainnet only for FCT trading)
const FCT_WETH_PAIR = networkConfig.fctWethPair;

const UNISWAP_V2_PAIR_ABI = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
]);

async function getEthPriceInUsd(): Promise<number> {
  try {
    // Use Facet's ETH price API
    const response = await fetch("https://eth-price.facet.org");
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json() as { priceInUSD: string };
    const price = parseFloat(data.priceInUSD);

    if (isNaN(price) || price <= 0) {
      throw new Error("Invalid price data received");
    }

    return price;
  } catch (error) {
    console.error("Failed to fetch ETH price from Facet API:", error);
    console.log("Using fallback ETH price");
    return 3500; // Fallback price
  }
}

async function getFctMarketPrice(): Promise<{
  priceInEth: bigint;
  priceInUsd: number;
} | null> {
  if (!isMainnet() || !FCT_WETH_PAIR) {
    console.log("FCT market price not available on testnet");
    return null;
  }

  try {
    // Get token addresses to determine order
    const [token0, token1] = await Promise.all([
      facetClient.readContract({
        address: FCT_WETH_PAIR as `0x${string}`,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token0",
      }),
      facetClient.readContract({
        address: FCT_WETH_PAIR as `0x${string}`,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token1",
      }),
    ]);

    // Get reserves
    const [reserve0, reserve1] = await facetClient.readContract({
      address: FCT_WETH_PAIR as `0x${string}`,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "getReserves",
    });

    // Determine token order dynamically
    const WETH = "0x1673540243E793B0e77C038D4a88448efF524DcE";
    let wethReserve: bigint, fctReserve: bigint;

    if ((token0 as string).toLowerCase() === WETH.toLowerCase()) {
      wethReserve = reserve0;
      fctReserve = reserve1;
    } else if ((token1 as string).toLowerCase() === WETH.toLowerCase()) {
      wethReserve = reserve1;
      fctReserve = reserve0;
    } else {
      console.log("WETH not found in pair");
      return null;
    }

    if (fctReserve === 0n || wethReserve === 0n) {
      return null;
    }

    // Calculate price: ETH per FCT (how much ETH to buy 1 FCT)
    const priceInEth = (wethReserve * 10n ** 18n) / fctReserve;

    // Get ETH price for USD conversion
    const ethPrice = await getEthPriceInUsd();
    const priceInUsd = Number(formatEther(priceInEth)) * ethPrice;

    return { priceInEth, priceInUsd };
  } catch (error) {
    console.error("Failed to fetch FCT market price:", error);
    return null;
  }
}

function createMineBoostData(sizeInBytes: number): Uint8Array {
  const data = new Uint8Array(sizeInBytes);
  const pattern = "FACETMINE";
  const encoder = new TextEncoder();
  const patternBytes = encoder.encode(pattern);

  for (let i = 0; i < data.length; i++) {
    data[i] = patternBytes[i % patternBytes.length];
  }

  return data;
}

function calculateDataGas(data: Uint8Array): bigint {
  let zeroBytes = 0n;
  let nonZeroBytes = 0n;

  for (const byte of data) {
    if (byte === 0) {
      zeroBytes++;
    } else {
      nonZeroBytes++;
    }
  }

  return zeroBytes * 10n + nonZeroBytes * 40n;
}

function formatCostPerFct(ethPerFct: bigint, ethPriceUsd: number): string {
  const ethAmount = Number(formatEther(ethPerFct));
  const usdAmount = ethAmount * ethPriceUsd;

  if (usdAmount < 0.0001) {
    return `<$0.0001 per FCT`;
  } else if (usdAmount < 0.01) {
    return `$${usdAmount.toFixed(5)} per FCT`;
  } else {
    return `$${usdAmount.toFixed(4)} per FCT`;
  }
}

async function selectMiningSize(
  ethPriceUsd: number
): Promise<{ selectedSize: number; estimatedCostPerTx: bigint } | null> {
  // Define size options (capped at 100KB)
  const sizeOptions = [
    { label: "Small", size: 25 * 1024, kb: 25 },
    { label: "Medium", size: 50 * 1024, kb: 50 },
    { label: "Large", size: 75 * 1024, kb: 75 },
    { label: "XL", size: 100 * 1024, kb: 100 },
  ];

  // Get current base fee for estimates (same as actual transaction)
  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const adjustedBaseFee = BigInt(
    Math.floor(Number(baseFee) * gasPriceMultiplier)
  );

  // Get FCT mint rate
  const fctMintRate = await getFctMintRate(networkConfig.l1Chain.id);

  // Calculate and display each option
  const optionCosts: bigint[] = [];
  for (let i = 0; i < sizeOptions.length; i++) {
    const option = sizeOptions[i];
    const overheadBytes = 160;
    const mineBoostSize = option.size - overheadBytes;

    // Estimate gas costs
    const baseExecutionGas = 21000n;
    const estimatedInputCostGas =
      calculateInputGasCost(new Uint8Array(mineBoostSize).fill(70)) +
      baseExecutionGas; // Use 'F' (70) as non-zero byte
    const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;
    const inputCostWei = estimatedInputCostGas * baseFee;
    const fctMintAmount = inputCostWei * fctMintRate;

    optionCosts.push(estimatedEthBurn);

    const costEth = Number(formatEther(estimatedEthBurn));
    const costUsd = costEth * ethPriceUsd;
    const fctAmount = Number(formatEther(fctMintAmount));
    const costPerFct = fctAmount > 0 ? costUsd / fctAmount : 0;

    console.log(
      `  ${i + 1}. ${option.label.padEnd(8)} (${option.kb}KB)  - ${formatEther(
        estimatedEthBurn
      ).padStart(8)} ETH ($${costUsd.toFixed(2).padStart(5)}), ~${fctAmount
        .toFixed(0)
        .padStart(4)} FCT`
    );
  }

  console.log(`  5. Custom     (specify KB, max 100)`);

  const choice = await prompt("\nChoose option (1-5): ");

  if (choice === "1" || choice === "2" || choice === "3" || choice === "4") {
    const selectedIndex = parseInt(choice) - 1;
    const selectedOption = sizeOptions[selectedIndex];
    ui.showMiningSelection(selectedOption.label, selectedOption.kb + "KB");
    return {
      selectedSize: selectedOption.size,
      estimatedCostPerTx: optionCosts[selectedIndex],
    };
  } else if (choice === "5") {
    const customInput = await prompt("Enter KB size (1-100): ");
    const customKb = parseInt(customInput);

    if (isNaN(customKb) || customKb < 1 || customKb > 100) {
      console.log("Invalid size. Must be between 1-100 KB");
      return null;
    }

    const customSize = customKb * 1024;

    // Calculate cost for custom size
    const overheadBytes = 160;
    const mineBoostSize = customSize - overheadBytes;
    const baseExecutionGas = 21000n;
    const estimatedInputCostGas =
      calculateInputGasCost(new Uint8Array(mineBoostSize).fill(70)) +
      baseExecutionGas;
    const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;

    ui.showMiningSelection("Custom", customKb + "KB");
    return {
      selectedSize: customSize,
      estimatedCostPerTx: estimatedEthBurn,
    };
  } else {
    console.log("Invalid choice");
    return null;
  }
}

async function miningLoop(
  spendCap: bigint,
  ethPriceUsd: number,
  dataSize: number,
  db: MiningDatabase,
  analytics: AnalyticsEngine,
  miningConfig: MiningConfig
) {
  const balance = await publicClient.getBalance({ address: account.address });

  // Create a new mining session in the database
  const sessionId = db.createSession("enhanced");

  console.log(
    chalk.cyan(`>> Starting Enhanced Mining Session #${sessionId}\n`)
  );

  // Build rules for evaluation from mining config
  const rules = buildRulesFromConfig(miningConfig);

  // Initialize dashboard with mining config
  const dashboard = new MiningDashboard(
    {
      sessionTarget: spendCap,
      currentBalance: balance,
      ethPrice: ethPriceUsd,
      remainingBudget: spendCap,
    },
    miningConfig
  );

  dashboard.start();

  let totalSpent = 0n;
  let totalFctMinted = 0n;
  let transactionCount = 0;

  try {
    while (totalSpent < spendCap) {
      transactionCount++;

      // Rule evaluation for mining features (if any rules are configured)
      if (rules.length > 0) {
        // Get current network conditions
        const currentGasPrice = await publicClient.getGasPrice();
        const currentBlock = await publicClient.getBlock();
        const currentBaseFee = currentBlock.baseFeePerGas || 0n;
        let currentMintRate = 0n;
        try {
          currentMintRate = await getFctMintRate(networkConfig.l1Chain.id);
        } catch (error) {
          // Use default mint rate if getFctMintRate fails (e.g., on testnets)
          currentMintRate = 0n;
        }

        // Collect runtime context for rule evaluation
        const runtimeContext = await collectRuntimeContext(
          totalSpent,
          totalFctMinted,
          currentGasPrice,
          currentBaseFee,
          currentMintRate,
          ethPriceUsd
        );

        // Evaluate all rules
        const shouldContinue = await evaluateRules(rules, runtimeContext);

        if (!shouldContinue) {
          console.log(
            chalk.yellow(">> Mining rules indicate stopping conditions met")
          );
          break;
        }
      }

      // Estimate transaction cost
      const estimatedCost = await estimateTransactionCost(
        dataSize,
        ethPriceUsd
      );

      // Check if we have enough for another transaction
      if (totalSpent + estimatedCost > spendCap) {
        break;
      }

      // Start transaction in dashboard
      dashboard.startTransaction({
        status: "preparing",
        ethCost: estimatedCost,
        fctMinted: 0n,
      });

      try {
        const result = await mineFacetTransactionWithDashboard(
          ethPriceUsd,
          dataSize,
          dashboard
        );

        if (result) {
          totalSpent += result.ethSpent;
          totalFctMinted += result.fctMinted;

          // Save transaction to database
          const miningResult = {
            l1Hash: result.l1Hash,
            facetHash: result.facetHash,
            ethBurned: result.ethSpent,
            fctMinted: result.fctMinted,
            efficiency: result.efficiency,
            costPerFct: result.costPerFct,
            gasUsed: result.gasUsed,
            effectiveGasPrice: result.effectiveGasPrice,
            baseFeePerGas: result.baseFeePerGas,
          };

          db.saveTransaction(miningResult, sessionId);

          // Update dashboard with completed transaction
          dashboard.completeTransaction(result.ethSpent, result.fctMinted);

          // Check if we have enough for another transaction
          if (totalSpent + estimatedCost > spendCap) {
            break;
          }
        } else {
          dashboard.updateTransaction({ status: "failed" });
          break;
        }
      } catch (error) {
        dashboard.updateTransaction({ status: "failed" });
        console.error(`Transaction ${transactionCount} failed:`, error);
        break;
      }
    }
  } finally {
    dashboard.stop();

    // End the session in database
    db.endSession(sessionId);

    await showFinalSummaryWithAnalytics(
      totalSpent,
      totalFctMinted,
      ethPriceUsd,
      transactionCount,
      sessionId,
      db,
      analytics
    );
  }
}

async function estimateTransactionCost(
  dataSize: number,
  ethPriceUsd: number
): Promise<bigint> {
  const overheadBytes = 160;
  const mineBoostSize = dataSize - overheadBytes;
  const mineBoostData = createMineBoostData(mineBoostSize);

  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const adjustedBaseFee = BigInt(
    Math.floor(Number(baseFee) * gasPriceMultiplier)
  );

  const baseExecutionGas = 21000n;
  const estimatedInputCostGas =
    calculateInputGasCost(mineBoostData) + baseExecutionGas;

  return estimatedInputCostGas * adjustedBaseFee;
}

async function mineFacetTransactionWithDashboard(
  ethPriceUsd: number,
  dataSize: number,
  dashboard: MiningDashboard
): Promise<{
  facetHash: string;
  l1Hash: string;
  ethSpent: bigint;
  fctMinted: bigint;
  costPerFct: bigint;
  efficiency: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  baseFeePerGas: bigint;
} | null> {
  const actualDataSize = dataSize || 100 * 1024;
  const overheadBytes = 160;
  const mineBoostSize = actualDataSize - overheadBytes;
  const mineBoostData = createMineBoostData(mineBoostSize);

  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const currentGasPrice = await publicClient.getGasPrice();
  const boostedGasPrice = BigInt(
    Math.floor(Number(currentGasPrice) * gasPriceMultiplier)
  );

  // Get current block for baseFee
  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || currentGasPrice;

  dashboard.updateTransaction({ status: "submitting" });

  try {
    const l1Nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    const { l1TransactionHash, facetTransactionHash } =
      await sendRawFacetTransaction(
        networkConfig.l1Chain.id,
        account.address,
        {
          to: account.address,
          value: 0n,
          data: "0x",
          mineBoost: toHex(mineBoostData),
        },
        (l1Transaction) => {
          return walletClient.sendTransaction({
            ...l1Transaction,
            account,
            gasPrice: boostedGasPrice,
            nonce: l1Nonce,
            kzg: undefined,
            chain: undefined,
          });
        }
      );

    dashboard.updateTransaction({
      status: "confirming",
      hash: facetTransactionHash,
    });

    // Wait for L1 confirmation to get actual gas data
    const l1Receipt = await publicClient.waitForTransactionReceipt({
      hash: l1TransactionHash as `0x${string}`,
      timeout: 60_000,
    });

    // Wait for Facet confirmation
    const facetReceipt = await facetClient.waitForTransactionReceipt({
      hash: facetTransactionHash as `0x${string}`,
      timeout: 60_000,
    });

    const facetTx = await facetClient.getTransaction({
      hash: facetTransactionHash as `0x${string}`,
    });

    let actualFctMinted = 0n;
    if (facetTx && "mint" in facetTx && facetTx.mint) {
      actualFctMinted = BigInt(facetTx.mint as string | number | bigint);
    }

    // Get actual gas usage and cost
    const actualGasUsed = l1Receipt.gasUsed || 0n;
    const actualEffectiveGasPrice =
      l1Receipt.effectiveGasPrice || boostedGasPrice;
    const actualEthBurned = actualEffectiveGasPrice * actualGasUsed;

    // Calculate efficiency using the new calculator
    const baseExecutionGas = 21000n;
    const calldataGas = actualGasUsed - baseExecutionGas;
    const efficiency = (Number(calldataGas) / Number(actualGasUsed)) * 100;

    const actualEthPerFct =
      actualFctMinted > 0n
        ? (actualEthBurned * 10n ** 18n) / actualFctMinted
        : 0n;

    dashboard.updateTransaction({
      status: "completed",
      fctMinted: actualFctMinted,
    });

    return {
      facetHash: facetTransactionHash,
      l1Hash: l1TransactionHash,
      ethSpent: actualEthBurned,
      fctMinted: actualFctMinted,
      costPerFct: actualEthPerFct,
      efficiency,
      gasUsed: actualGasUsed,
      effectiveGasPrice: actualEffectiveGasPrice,
      baseFeePerGas: baseFee,
    };
  } catch (error) {
    dashboard.updateTransaction({ status: "failed" });
    return null;
  }
}

async function mineFacetTransaction(
  ethPriceUsd?: number,
  dataSize?: number
): Promise<{
  facetHash: string;
  l1Hash: string;
  ethSpent: bigint;
  fctMinted: bigint;
  costPerFct: bigint;
} | null> {
  const actualDataSize = dataSize || 100 * 1024; // Default to 100KB if not specified
  const overheadBytes = 160;
  const mineBoostSize = actualDataSize - overheadBytes;

  // Get prices (use provided price or fetch new one)
  const currentEthPriceUsd = ethPriceUsd || (await getEthPriceInUsd());
  console.log(`ETH Price: $${currentEthPriceUsd.toFixed(2)}`);

  const fctMarketPrice = await getFctMarketPrice();
  if (fctMarketPrice) {
    console.log(
      `FCT Market Price (Uniswap V2): ${formatEther(
        fctMarketPrice.priceInEth
      )} ETH ($${fctMarketPrice.priceInUsd.toFixed(6)})`
    );
  }

  const mineBoostData = createMineBoostData(mineBoostSize);
  const dataGas = calculateDataGas(mineBoostData);

  const currentBlock = await publicClient.getBlock();
  const baseFee = currentBlock.baseFeePerGas || 0n;

  // Get FCT mint rate for estimation (note: actual mining amount is non-deterministic)
  const fctMintRate = await getFctMintRate(networkConfig.l1Chain.id);

  // Estimate calldata cost for display purposes
  const baseExecutionGas = 21000n;
  const estimatedInputCostGas =
    calculateInputGasCost(mineBoostData) + baseExecutionGas;
  // Use baseFee (not gasPrice) for FCT calculation
  const inputCostWei = (estimatedInputCostGas - baseExecutionGas) * baseFee;
  const fctMintAmount = inputCostWei * fctMintRate;

  // Get gas price multiplier for accurate cost calculation
  const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
  const adjustedBaseFee = BigInt(
    Math.floor(Number(baseFee) * gasPriceMultiplier)
  );

  // Estimate total ETH burn for display (actual will be handled by SDK)
  const estimatedEthBurn = estimatedInputCostGas * adjustedBaseFee;

  console.log("\nGas Estimates:");
  console.log("  Data gas:", dataGas.toString(), "gas");
  console.log("  Estimated L1 gas:", estimatedInputCostGas.toString(), "gas");
  console.log("  Base fee:", formatGwei(baseFee), "gwei");
  console.log(
    "  Adjusted fee (+" + Math.round((gasPriceMultiplier - 1) * 100) + "%):",
    formatGwei(adjustedBaseFee),
    "gwei"
  );
  console.log("  Input cost:", estimatedInputCostGas.toString(), "gas units");
  console.log("  Input cost in ETH:", formatEther(inputCostWei), "ETH");
  console.log(
    "  FCT mint rate:",
    fctMintRate.toString(),
    "FCT-wei per ETH-wei"
  );

  // Calculate price correctly: ETH per FCT (cost to get 1 FCT)
  const ethPerFct =
    fctMintAmount > 0n ? (estimatedEthBurn * 10n ** 18n) / fctMintAmount : 0n;

  // Calculate fully diluted valuation
  const fctPriceUsd = Number(formatEther(ethPerFct)) * currentEthPriceUsd;
  const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
  const fullyDilutedValue = maxSupplyInFct * fctPriceUsd;

  console.log("\nExpected Results:");
  const ethBurnUsd = Number(formatEther(estimatedEthBurn)) * currentEthPriceUsd;
  console.log(
    "  ETH to burn:",
    formatEther(estimatedEthBurn),
    "ETH",
    `($${ethBurnUsd.toFixed(2)})`
  );
  console.log("  FCT to mint:", formatEther(fctMintAmount), "FCT");
  console.log("  Cost per FCT:", formatEther(ethPerFct), "ETH");
  console.log(
    "  Cost per FCT (USD):",
    formatCostPerFct(ethPerFct, currentEthPriceUsd)
  );

  // Calculate and display overhead
  // L1 overhead is just the base transaction cost (21000 gas)
  // Everything else (all calldata) contributes to FCT minting
  // Note: baseExecutionGas and actualCalldataGas are already defined above
  const calldataEthCost = inputCostWei; // Already calculated above
  const executionEthCost = baseExecutionGas * baseFee;
  const calldataEthUsd =
    Number(formatEther(calldataEthCost)) * currentEthPriceUsd;
  const executionEthUsd =
    Number(formatEther(executionEthCost)) * currentEthPriceUsd;
  const efficiencyPercent =
    (Number(estimatedInputCostGas - baseExecutionGas) /
      Number(estimatedInputCostGas)) *
    100;

  console.log("\nCost Breakdown:");
  console.log(
    "  Calldata cost (generates FCT):",
    formatEther(calldataEthCost),
    "ETH",
    `($${calldataEthUsd.toFixed(2)})`
  );
  console.log(
    "  L1 base cost (21k gas):",
    formatEther(executionEthCost),
    "ETH",
    `($${executionEthUsd.toFixed(2)})`
  );
  console.log(
    "  Mining efficiency:",
    `${efficiencyPercent.toFixed(1)}%`,
    `(${(100 - efficiencyPercent).toFixed(1)}% overhead)`
  );

  // Compare with market price
  if (fctMarketPrice) {
    const miningPremium =
      ((Number(formatEther(ethPerFct)) -
        Number(formatEther(fctMarketPrice.priceInEth))) /
        Number(formatEther(fctMarketPrice.priceInEth))) *
      100;
    if (miningPremium > 0) {
      console.log(
        `  ⚠️  Mining cost is ${miningPremium.toFixed(1)}% above market price`
      );
    } else {
      console.log(
        `  Mining cost is ${Math.abs(miningPremium).toFixed(
          1
        )}% below market price`
      );
    }
  }

  // Compare mining vs swapping (mainnet only)
  if (isMainnet()) {
    await compareMiningVsSwapping(estimatedEthBurn, fctMintAmount, ethPerFct);
  }
  console.log("\nMarket Valuation:");
  console.log("  FCT Max Supply:", maxSupplyInFct.toLocaleString(), "FCT");
  console.log(
    "  Fully Diluted Valuation:",
    `$${fullyDilutedValue.toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })}`
  );

  console.log("\nSending transaction...");

  // Get current gas price and apply multiplier to avoid getting stuck
  const currentGasPrice = await publicClient.getGasPrice();
  const boostedGasPrice = BigInt(
    Math.floor(Number(currentGasPrice) * gasPriceMultiplier)
  );

  console.log("Gas price strategy:");
  console.log(
    "  Current network gas price:",
    formatGwei(currentGasPrice),
    "gwei"
  );
  console.log(
    "  Boosted gas price (+" +
      Math.round((gasPriceMultiplier - 1) * 100) +
      "% buffer):",
    formatGwei(boostedGasPrice),
    "gwei"
  );

  try {
    // Get current nonce before sending
    const l1Nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    // Use SDK to send the Facet transaction with mine boost
    const { l1TransactionHash, facetTransactionHash } =
      await sendRawFacetTransaction(
        networkConfig.l1Chain.id,
        account.address,
        {
          to: account.address,
          value: 0n,
          data: "0x",
          mineBoost: toHex(mineBoostData),
        },
        (l1Transaction) => {
          return walletClient.sendTransaction({
            ...l1Transaction,
            account,
            gasPrice: boostedGasPrice,
            nonce: l1Nonce,
            kzg: undefined,
            chain: undefined,
          });
        }
      );

    console.log("L1 transaction hash:", l1TransactionHash);
    console.log("L1 transaction nonce:", l1Nonce);
    console.log("Facet transaction hash:", facetTransactionHash);
    const facetHash = facetTransactionHash;
    console.log("Waiting for Facet confirmation...");

    let actualFctMinted = 0n;
    let actualEthBurned = estimatedEthBurn; // Fallback to estimate
    let actualGasUsed = estimatedInputCostGas; // Fallback to estimate
    let actualGasPrice = boostedGasPrice; // Use the gas price we set
    let isConfirmed = false;

    // Get L1 receipt for actual gas used
    try {
      const l1Receipt = await publicClient.waitForTransactionReceipt({
        hash: l1TransactionHash as `0x${string}`,
        timeout: 60_000,
      });
      actualEthBurned =
        (l1Receipt.effectiveGasPrice ?? boostedGasPrice) *
        (l1Receipt.gasUsed ?? 0n);
      actualGasUsed = l1Receipt.gasUsed ?? estimatedInputCostGas;
      actualGasPrice = l1Receipt.effectiveGasPrice ?? boostedGasPrice;
    } catch (l1Error) {
      console.log("Warning: Could not get L1 receipt, using estimates");
    }

    try {
      const facetReceipt = await facetClient.waitForTransactionReceipt({
        hash: facetHash as `0x${string}`,
        timeout: 60_000, // 60 second timeout
      });

      // Get the full transaction to access the mint field
      const facetTx = await facetClient.getTransaction({
        hash: facetHash as `0x${string}`,
      });

      // The Facet transaction has a 'mint' field with the actual FCT minted
      if (facetTx && "mint" in facetTx && facetTx.mint) {
        actualFctMinted = BigInt(facetTx.mint as string | number | bigint);
        isConfirmed = true;
        console.log("Facet transaction confirmed");
        console.log("  Facet block:", facetReceipt.blockNumber);
        console.log(
          "  Actual FCT minted:",
          formatEther(actualFctMinted),
          "FCT"
        );
      } else {
        // Fallback to estimated amount if mint field not found
        console.log(
          "Warning: Could not find mint field, using estimated amount"
        );
        actualFctMinted = fctMintAmount;
      }
    } catch (error) {
      console.log(
        "Facet confirmation timeout after 60 seconds - stopping mining"
      );
      console.log(
        "   L1 transaction may have failed or Facet indexing is delayed"
      );
      return null;
    }

    // Calculate actual price: ETH per FCT
    const actualEthPerFct =
      actualFctMinted > 0n
        ? (actualEthBurned * 10n ** 18n) / actualFctMinted
        : 0n;

    if (isConfirmed) {
      console.log("\nTransaction Confirmed!");
    } else {
      console.log("\n⏳ Transaction Submitted (pending confirmation)");
    }
    console.log("L1 Hash:", l1TransactionHash);
    console.log("L1 Nonce:", l1Nonce);
    console.log("Facet Hash:", facetHash);
    console.log("\nActual Results:");
    console.log("  Gas used:", actualGasUsed.toString());
    console.log("  Gas price:", formatGwei(actualGasPrice), "gwei");
    // Calculate actual fully diluted valuation
    const actualFctPriceUsd =
      Number(formatEther(actualEthPerFct)) * currentEthPriceUsd;
    const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
    const actualFdv = maxSupplyInFct * actualFctPriceUsd;

    const actualEthBurnUsd =
      Number(formatEther(actualEthBurned)) * currentEthPriceUsd;
    console.log(
      "  ETH burned:",
      formatEther(actualEthBurned),
      "ETH",
      `($${actualEthBurnUsd.toFixed(2)})`
    );
    console.log("  FCT minted:", formatEther(actualFctMinted), "FCT");
    console.log("  Actual cost per FCT:", formatEther(actualEthPerFct), "ETH");
    console.log(
      "  Actual cost per FCT (USD):",
      formatCostPerFct(actualEthPerFct, currentEthPriceUsd)
    );
    console.log("\nActual Market Metrics:");
    console.log(
      "  Fully Diluted Valuation (FDV):",
      `$${actualFdv.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    );

    // Return transaction results
    return {
      facetHash,
      l1Hash: l1TransactionHash,
      ethSpent: actualEthBurned,
      fctMinted: actualFctMinted,
      costPerFct: actualEthPerFct,
    };
  } catch (error) {
    console.error("Transaction failed:", error);
    return null;
  }
}

async function showFinalSummaryWithAnalytics(
  totalSpent: bigint,
  totalFctMinted: bigint,
  ethPriceUsd: number,
  transactionCount: number,
  sessionId: number,
  db: MiningDatabase,
  analytics: AnalyticsEngine
) {
  console.clear();

  // Keep the same header as always
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
  console.log("");

  const totalSpentUSD = Number(formatEther(totalSpent)) * ethPriceUsd;
  const avgCostPerFct =
    totalFctMinted > 0n
      ? totalSpentUSD / Number(formatEther(totalFctMinted))
      : 0;

  console.log(chalk.cyan("\nFinal Results:"));
  console.log(
    `  ${chalk.white("Transactions:")} ${chalk.green.bold(transactionCount)}`
  );
  console.log(
    `  ${chalk.white("ETH Spent:")} ${chalk.yellow.bold(
      formatEther(totalSpent).slice(0, 8)
    )} ETH`
  );
  console.log(
    `  ${chalk.white("USD Spent:")} ${chalk.yellow.bold(
      "$" + totalSpentUSD.toFixed(2)
    )}`
  );
  console.log(
    `  ${chalk.white("FCT Mined:")} ${chalk.green.bold(
      formatEther(totalFctMinted).slice(0, 8)
    )} FCT`
  );
  console.log(
    `  ${chalk.white("Avg Cost:")} ${chalk.magenta.bold(
      "$" + avgCostPerFct.toFixed(4)
    )} per FCT`
  );

  if (totalFctMinted > 0n) {
    const maxSupplyInFct = Number(formatEther(FCT_MAX_SUPPLY));
    const impliedFDV = maxSupplyInFct * avgCostPerFct;
    console.log(
      `  ${chalk.white("Implied FDV:")} ${chalk.blue.bold(
        "$" + impliedFDV.toLocaleString(undefined, { maximumFractionDigits: 0 })
      )}`
    );
  }

  // Add analytics insights
  const sessionStats = db.getSessionStats(sessionId);
  if (sessionStats) {
    console.log(chalk.cyan("\n>> Session Analytics:"));
    console.log(
      chalk.white(
        `  Mining efficiency: ${sessionStats.avgEfficiency.toFixed(1)}%`
      )
    );

    // Get recent transactions for analysis
    const recentTxs = db.getRecentTransactions(5);
    if (recentTxs.length > 0) {
      const bestTx = recentTxs.reduce((best, tx) =>
        tx.ethBurnedEth / tx.fctMintedFct <
        best.ethBurnedEth / best.fctMintedFct
          ? tx
          : best
      );
      console.log(
        chalk.white(
          `  Best transaction: ${bestTx.fctMintedFct.toFixed(
            4
          )} FCT for ${bestTx.ethBurnedEth.toFixed(6)} ETH`
        )
      );
    }

    // Show best mining hours from all-time data
    const bestHours = db.getBestHours(3);
    if (bestHours.length > 0) {
      console.log(chalk.cyan("\n>> Mining Insights:"));
      console.log(chalk.white("  Optimal mining hours based on your history:"));
      bestHours.forEach((h, i) => {
        console.log(
          chalk.gray(
            `    ${i + 1}. Hour ${h.hour}:00 - ${(
              h.avgFctPerEth * 1000
            ).toFixed(2)} FCT/ETH (${h.txCount} previous txs)`
          )
        );
      });
    }

    // Show analytics command suggestion
    console.log(chalk.cyan("\n>> View Detailed Analytics:"));
    console.log(
      chalk.gray(
        `  Run: ${chalk.white(
          "pnpm mine --analyze"
        )} for comprehensive insights`
      )
    );
    console.log(
      chalk.gray(
        `  Run: ${chalk.white(
          `pnpm mine --analyze --session ${sessionId}`
        )} for this session only`
      )
    );
  }

  console.log(
    chalk.green("\n>> Interactive Mining Session completed successfully!")
  );
  console.log(
    chalk.yellow(">> All data has been saved to ./mining-data/mining.json")
  );
}

async function startInteractiveMining(options: any) {
  ui.showHeader(getCurrentNetwork(), account.address);

  // Create mining configuration from options (preserving all features)
  const miningConfig: MiningConfig = {
    strategy: (options.strategy as MiningStrategy) || MiningStrategy.AUTO,
    maxCostPerFct: options.maxCostUsd,
    minEfficiency: options.minEfficiency,
    scheduleHours: options.hours,
    dailyBudgetEth: options.budget,
    targetFctAmount: options.target,
    checkIntervalMs: options.interval || 30000,
    maxDataSizeKb: options.maxSize || 100,
  };

  // Validate strategy if provided
  if (options.strategy) {
    const validStrategies = Object.values(MiningStrategy);
    if (!validStrategies.includes(options.strategy as MiningStrategy)) {
      console.error(chalk.red(`Invalid strategy: ${options.strategy}`));
      console.error(
        chalk.yellow(`Valid strategies: ${validStrategies.join(", ")}`)
      );
      process.exit(1);
    }
  }

  // Initialize database and analytics
  const db = new MiningDatabase();
  const analytics = new AnalyticsEngine(db);

  // Check if there's previous mining data
  const allTimeStats = db.getAllTimeStats();
  if (allTimeStats.txCount > 0) {
    console.log(chalk.cyan(">> Previous Mining History Found:"));
    console.log(chalk.white(`  Total transactions: ${allTimeStats.txCount}`));
    console.log(
      chalk.white(`  Total FCT mined: ${allTimeStats.totalFctFct.toFixed(2)}`)
    );
    console.log(
      chalk.white(`  Total ETH spent: ${allTimeStats.totalEthEth.toFixed(4)}`)
    );
    console.log(
      chalk.white(
        `  Average cost/FCT: $${(allTimeStats.avgCostPerFct * 3500).toFixed(5)}`
      )
    );

    // Show best mining hours if available
    const bestHours = db.getBestHours(3);
    if (bestHours.length > 0) {
      console.log(chalk.cyan("  Best mining hours:"));
      bestHours.forEach((h, i) => {
        console.log(
          chalk.gray(`    ${i + 1}. Hour ${h.hour}:00 (${h.txCount} txs)`)
        );
      });
    }
    console.log("");
  }

  // Get wallet balance
  const balance = await publicClient.getBalance({
    address: account.address,
  });

  // Get ETH price for USD calculations
  const ethPriceUsd = await getEthPriceInUsd();
  const balanceUsd = Number(formatEther(balance)) * ethPriceUsd;

  // Show system info in dashboard style
  ui.showSystemInfo(
    getCurrentNetwork(),
    account.address,
    formatEther(balance),
    ethPriceUsd,
    balanceUsd
  );

  // Display mining configuration if any advanced features are being used
  const hasAdvancedConfig =
    miningConfig.maxCostPerFct ||
    miningConfig.minEfficiency ||
    miningConfig.scheduleHours ||
    miningConfig.targetFctAmount ||
    miningConfig.strategy !== MiningStrategy.AUTO ||
    options.interval;

  if (hasAdvancedConfig) {
    console.log(chalk.cyan(">> Mining Configuration:"));
    console.log(chalk.white(`  Strategy: ${miningConfig.strategy}`));

    if (miningConfig.maxCostPerFct)
      console.log(
        chalk.white(`  Max cost/FCT: $${miningConfig.maxCostPerFct}`)
      );

    if (miningConfig.minEfficiency)
      console.log(
        chalk.white(`  Min efficiency: ${miningConfig.minEfficiency}%`)
      );

    if (miningConfig.scheduleHours)
      console.log(
        chalk.white(`  Schedule: hours ${miningConfig.scheduleHours.join(",")}`)
      );

    if (miningConfig.targetFctAmount)
      console.log(chalk.white(`  Target: ${miningConfig.targetFctAmount} FCT`));

    if (options.interval && miningConfig.checkIntervalMs)
      console.log(
        chalk.white(`  Check interval: ${miningConfig.checkIntervalMs / 1000}s`)
      );

    console.log("");
  }

  if (balance === 0n) {
    console.log(chalk.red("Error: Wallet has no ETH to spend"));
    return;
  }

  // Handle mining size - use flag if provided, otherwise prompt
  let selectedSize: number;
  let estimatedCostPerTx: bigint;

  if (options.maxSize) {
    // Use flag value
    selectedSize = options.maxSize * 1024; // Convert KB to bytes

    // Calculate cost for the specified size
    const overheadBytes = 160;
    const mineBoostSize = selectedSize - overheadBytes;
    const baseExecutionGas = 21000n;
    const currentBlock = await publicClient.getBlock();
    const baseFee = currentBlock.baseFeePerGas || 0n;
    const gasPriceMultiplier = Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5;
    const adjustedBaseFee = BigInt(
      Math.floor(Number(baseFee) * gasPriceMultiplier)
    );

    const estimatedInputCostGas =
      calculateInputGasCost(new Uint8Array(mineBoostSize).fill(70)) +
      baseExecutionGas;
    estimatedCostPerTx = estimatedInputCostGas * adjustedBaseFee;

    console.log(
      chalk.cyan(
        `Using data size: ${options.maxSize}KB (${selectedSize} bytes)`
      )
    );
  } else {
    // Show mining options header and prompt
    ui.showMiningOptions();

    const sizeResult = await selectMiningSize(ethPriceUsd);
    if (!sizeResult) {
      console.log("Mining cancelled");
      return;
    }

    selectedSize = sizeResult.selectedSize;
    estimatedCostPerTx = sizeResult.estimatedCostPerTx;
  }

  // Handle spending cap - use flag if provided, otherwise prompt
  let spendCap: bigint;

  if (options.budget) {
    // Use flag value
    spendCap = BigInt(Math.floor(options.budget * 1e18)); // Convert to wei

    if (spendCap > balance) {
      console.log(
        chalk.red(
          `Budget (${formatEther(
            spendCap
          )} ETH) exceeds wallet balance (${formatEther(balance)} ETH)`
        )
      );
      return;
    }

    const estimatedTxCount = Math.floor(
      Number(spendCap) / Number(estimatedCostPerTx)
    );
    console.log(
      chalk.cyan(
        `Using budget: ${formatEther(
          spendCap
        )} ETH (~${estimatedTxCount} transactions)`
      )
    );
  } else {
    // Show spending options and prompt
    ui.showSpendingOptions(
      formatEther(estimatedCostPerTx),
      `$${(Number(formatEther(estimatedCostPerTx)) * ethPriceUsd).toFixed(2)}`
    );

    const spendChoice = await prompt("\nChoose option (1 or 2): ");

    if (spendChoice === "1") {
      // Leave a small buffer for gas on the final transaction
      const buffer = BigInt(Math.floor(Number(balance) * 0.01)); // 1% buffer
      spendCap = balance - buffer;
      ui.showSpendingChoice(
        "all",
        `(${formatEther(spendCap)} ETH, leaving ${formatEther(
          buffer
        )} ETH buffer)`
      );
    } else if (spendChoice === "2") {
      const capInput = await prompt("Enter ETH spending cap (e.g., 0.01): ");
      const capFloat = parseFloat(capInput);

      if (isNaN(capFloat) || capFloat <= 0) {
        console.log("Invalid spending cap");
        return;
      }

      spendCap = BigInt(Math.floor(capFloat * 1e18)); // Convert to wei

      if (spendCap > balance) {
        console.log(
          `Spending cap (${formatEther(
            spendCap
          )} ETH) exceeds wallet balance (${formatEther(balance)} ETH)`
        );
        return;
      }

      const estimatedTxCount = Math.floor(
        Number(spendCap) / Number(estimatedCostPerTx)
      );
      ui.showSpendingChoice(
        "cap",
        `${formatEther(spendCap)} ETH (~${estimatedTxCount} transactions)`
      );
    } else {
      console.log("Invalid choice");
      return;
    }
  }

  // Start mining loop with database integration and mining config
  await miningLoop(
    spendCap,
    ethPriceUsd,
    selectedSize,
    db,
    analytics,
    miningConfig
  );

  // Close database connection
  db.close();
}

async function main() {
  // Parse command line arguments
  program.parse();
}

main().catch(console.error);
