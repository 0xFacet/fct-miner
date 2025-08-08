#!/usr/bin/env tsx
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
import chalk from "chalk";

dotenv.config();

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
    const data = await response.json();
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
  dataSize: number
) {
  const balance = await publicClient.getBalance({ address: account.address });

  // Initialize dashboard
  const dashboard = new MiningDashboard({
    sessionTarget: spendCap,
    currentBalance: balance,
    ethPrice: ethPriceUsd,
    remainingBudget: spendCap,
  });

  dashboard.start();

  let totalSpent = 0n;
  let totalFctMinted = 0n;
  let transactionCount = 0;

  try {
    while (totalSpent < spendCap) {
      transactionCount++;

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
    await showFinalSummary(
      totalSpent,
      totalFctMinted,
      ethPriceUsd,
      transactionCount
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
          });
        }
      );

    dashboard.updateTransaction({
      status: "confirming",
      hash: facetTransactionHash,
    });

    // Wait for confirmation with timeout
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

    const actualEthBurned = await estimateTransactionCost(
      dataSize,
      ethPriceUsd
    );
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
      actualEthBurned = (l1Receipt.effectiveGasPrice ?? boostedGasPrice) * (l1Receipt.gasUsed ?? 0n);
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

async function showFinalSummary(
  totalSpent: bigint,
  totalFctMinted: bigint,
  ethPriceUsd: number,
  transactionCount: number
) {
  console.clear();

  // Keep the same header as always
  const borderWidth = 79;
  const text = "FCT MINER v1.0";
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

  console.log(chalk.green("\nSession completed successfully!"));
  console.log(chalk.gray("Press any key to exit..."));
}

async function main() {
  await startMiningSession();
}

async function startMiningSession() {
  ui.showHeader(getCurrentNetwork(), account.address);

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

  if (balance === 0n) {
    console.log(chalk.red("Error: Wallet has no ETH to spend"));
    return;
  }

  // Show mining options header
  ui.showMiningOptions();

  // Ask for mining size first so user knows transaction costs
  const sizeResult = await selectMiningSize(ethPriceUsd);
  if (!sizeResult) {
    console.log("Mining cancelled");
    return;
  }

  const { selectedSize, estimatedCostPerTx } = sizeResult;

  // Now ask for spend cap with knowledge of transaction costs
  ui.showSpendingOptions(
    formatEther(estimatedCostPerTx),
    `$${(Number(formatEther(estimatedCostPerTx)) * ethPriceUsd).toFixed(2)}`
  );

  const spendChoice = await prompt("\nChoose option (1 or 2): ");

  let spendCap: bigint;

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

  // Start mining loop
  await miningLoop(spendCap, ethPriceUsd, selectedSize);
}

main().catch(console.error);
