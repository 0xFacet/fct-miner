#!/usr/bin/env tsx
import {
  createWalletClient,
  createPublicClient,
  http,
  formatEther,
  formatGwei,
  parseEther,
  parseAbi,
  toHex,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as dotenv from "dotenv";
import { getNetworkConfig, getCurrentNetwork, isMainnet } from "./config";

dotenv.config();

// Get network configuration
const networkConfig = getNetworkConfig();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY not found in .env file");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

// FCT max supply in wei
const FCT_MAX_SUPPLY = 1646951661163841381479607357n;

// Uniswap V2 addresses on Facet
const FCT_WETH_PAIR = "0x180eF813f5C3C00e37b002Dfe90035A8143CE233" as const;
const WETH_ADDRESS = "0x1673540243E793B0e77C038D4a88448efF524DcE" as const; // Token0 in the pair
const WRAPPED_FCT_ADDRESS =
  "0x4200000000000000000000000000000000000006" as const; // Token1 in the pair
const UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D" as const; // Standard Uniswap V2 router

// Uniswap V2 ABIs
const UNISWAP_V2_PAIR_ABI = parseAbi([
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
]);

const UNISWAP_V2_ROUTER_ABI = [
  "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
  "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
] as const;

// Get Facet chain configuration from network config
const facetChain = networkConfig.facetChain;

const facetClient = createPublicClient({
  chain: facetChain,
  transport: http(networkConfig.facetRpcUrl),
});

const facetWalletClient = createWalletClient({
  account,
  chain: facetChain,
  transport: http(networkConfig.facetRpcUrl),
});

// Calculate price impact for Uniswap V2
function calculatePriceImpact(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): { amountOut: bigint; priceImpact: number } {
  // Uniswap V2 formula with 0.3% fee
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  const amountOut = numerator / denominator;

  // Calculate price impact
  const spotPrice = (reserveIn * 10n ** 18n) / reserveOut;
  const newReserveIn = reserveIn + amountIn;
  const newReserveOut = reserveOut - amountOut;
  const executionPrice = (amountIn * 10n ** 18n) / amountOut;

  const priceImpact =
    Number(((executionPrice - spotPrice) * 10000n) / spotPrice) / 100;

  return { amountOut, priceImpact };
}

export async function getSwapQuote(ethAmount: bigint): Promise<{
  fctOut: bigint;
  priceImpact: number;
  effectivePrice: bigint;
  spotPrice: bigint;
} | null> {
  if (!isMainnet() || !networkConfig.fctWethPair) {
    console.log("Swapping not available on testnet");
    return null;
  }

  try {
    // Get token addresses to determine order
    const [token0Addr, token1Addr] = await Promise.all([
      facetClient.readContract({
        address: networkConfig.fctWethPair!,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token0",
      }),
      facetClient.readContract({
        address: networkConfig.fctWethPair!,
        abi: UNISWAP_V2_PAIR_ABI,
        functionName: "token1",
      }),
    ]);
    
    // Get current reserves
    const [reserve0, reserve1] = await facetClient.readContract({
      address: networkConfig.fctWethPair!,
      abi: UNISWAP_V2_PAIR_ABI,
      functionName: "getReserves",
    });

    // Determine token order dynamically
    let wethReserve: bigint, fctReserve: bigint;
    if ((token0Addr as string).toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      wethReserve = reserve0;
      fctReserve = reserve1;
    } else if ((token1Addr as string).toLowerCase() === WETH_ADDRESS.toLowerCase()) {
      wethReserve = reserve1;
      fctReserve = reserve0;
    } else {
      console.log("WETH not found in pair");
      return null;
    }

    // Calculate swap output and price impact
    const { amountOut, priceImpact } = calculatePriceImpact(
      ethAmount,
      wethReserve,
      fctReserve
    );

    // Calculate prices
    const spotPrice = (wethReserve * 10n ** 18n) / fctReserve;
    const effectivePrice = (ethAmount * 10n ** 18n) / amountOut;

    return {
      fctOut: amountOut,
      priceImpact,
      effectivePrice,
      spotPrice,
    };
  } catch (error) {
    console.error("Failed to get swap quote:", error);
    return null;
  }
}

export async function executeSwap(
  ethAmount: bigint,
  minFctOut: bigint,
  slippageBps: number = 50 // 0.5% default slippage
): Promise<string | null> {
  try {
    console.log("\n=== Executing Swap on Facet ===");
    console.log("Swapping:", formatEther(ethAmount), "ETH");
    console.log("Min FCT out:", formatEther(minFctOut), "FCT");
    console.log("Slippage:", slippageBps / 100, "%");

    // Calculate minimum output with slippage
    const minOutWithSlippage =
      (minFctOut * BigInt(10000 - slippageBps)) / 10000n;

    // Set deadline to 20 minutes from now
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

    // Path: WETH -> Wrapped FCT
    const path = [WETH_ADDRESS, WRAPPED_FCT_ADDRESS];

    // Encode the swap call
    const swapData = encodeAbiParameters(
      parseAbiParameters("uint256, address[], address, uint256"),
      [
        minOutWithSlippage,
        path as readonly Address[],
        account.address,
        deadline,
      ]
    );

    console.log("\nSending swap transaction...");

    // Send the swap transaction
    const txHash = await facetWalletClient.sendTransaction({
      to: UNISWAP_V2_ROUTER,
      value: ethAmount,
      data: `0x7ff36ab5${swapData.slice(2)}`, // swapExactETHForTokens selector
    });

    console.log("Transaction sent:", txHash);
    console.log("Waiting for confirmation...");

    // Wait for confirmation
    const receipt = await facetClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 30_000,
    });

    console.log("✅ Swap confirmed in block:", receipt.blockNumber);

    return txHash;
  } catch (error) {
    console.error("Swap failed:", error);
    return null;
  }
}

// Compare mining vs swapping
export async function compareMiningVsSwapping(
  ethToSpend: bigint,
  miningFctAmount: bigint,
  miningCostPerFct: bigint
): Promise<void> {
  const swapQuote = await getSwapQuote(ethToSpend);

  if (!swapQuote) {
    console.log("Could not get swap quote for comparison");
    return;
  }

  console.log("\n=== Mining vs Swapping Comparison ===");

  // Mining option
  console.log("\n📦 MINING:");
  console.log("  FCT received:", formatEther(miningFctAmount), "FCT");
  console.log("  Cost per FCT:", formatEther(miningCostPerFct), "ETH");

  // Swapping option
  console.log("\n💱 SWAPPING:");
  console.log("  FCT received:", formatEther(swapQuote.fctOut), "FCT");
  console.log("  Cost per FCT:", formatEther(swapQuote.effectivePrice), "ETH");
  console.log("  Price impact:", swapQuote.priceImpact.toFixed(2), "%");

  // Comparison
  const swapIsBetter = swapQuote.fctOut > miningFctAmount;
  const percentDiff =
    ((Number(swapQuote.fctOut) - Number(miningFctAmount)) /
      Number(miningFctAmount)) *
    100;

  console.log("\n📊 RECOMMENDATION:");
  if (swapIsBetter) {
    console.log(
      `  ✅ SWAP is better: Get ${Math.abs(percentDiff).toFixed(1)}% more FCT`
    );
    if (swapQuote.priceImpact > 1) {
      console.log(
        `  ⚠️  Warning: High price impact (${swapQuote.priceImpact.toFixed(
          2
        )}%)`
      );
    }
  } else {
    console.log(
      `  ⛏️  MINING is better: Get ${Math.abs(percentDiff).toFixed(
        1
      )}% more FCT`
    );
  }

  // Show arbitrage opportunity if significant
  if (Math.abs(percentDiff) > 5) {
    console.log("\n💰 ARBITRAGE OPPORTUNITY:");
    if (swapIsBetter) {
      console.log(
        "  Buy from pool, wait for mint rate adjustment, then mine and sell"
      );
    } else {
      console.log("  Mine FCT and sell to pool for profit");
    }
  }
}

// Main function for standalone usage
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  bun facet-swapper.ts quote <eth_amount>   - Get swap quote");
    console.log(
      "  bun facet-swapper.ts swap <eth_amount> [slippage_bps] - Execute swap"
    );
    console.log("Example:");
    console.log("  bun facet-swapper.ts quote 0.01");
    console.log("  bun facet-swapper.ts swap 0.01 100  # 1% slippage");
    process.exit(1);
  }

  const command = args[0];
  const ethAmount = parseEther(args[1] || "0");

  if (command === "quote") {
    const quote = await getSwapQuote(ethAmount);
    if (quote) {
      console.log("\n=== Swap Quote ===");
      console.log("Input:", formatEther(ethAmount), "ETH");
      console.log("Output:", formatEther(quote.fctOut), "FCT");
      console.log("Spot price:", formatEther(quote.spotPrice), "ETH per FCT");
      console.log(
        "Effective price:",
        formatEther(quote.effectivePrice),
        "ETH per FCT"
      );
      console.log("Price impact:", quote.priceImpact.toFixed(2), "%");
    }
  } else if (command === "swap") {
    const slippage = args[2] ? parseInt(args[2]) : 50; // Default 0.5%
    const quote = await getSwapQuote(ethAmount);

    if (quote) {
      console.log("\n=== Swap Preview ===");
      console.log("Expected FCT:", formatEther(quote.fctOut), "FCT");
      console.log("Price impact:", quote.priceImpact.toFixed(2), "%");

      if (quote.priceImpact > 5) {
        console.log(
          "\n⚠️  WARNING: High price impact! Consider smaller swap or mining instead."
        );
      }

      const confirm = prompt("\nProceed with swap? (y/n): ");
      if (confirm?.toLowerCase() === "y") {
        await executeSwap(ethAmount, quote.fctOut, slippage);
      }
    }
  }
}

// Functions are already exported inline

// Run if called directly
if (import.meta.main) {
  main().catch(console.error);
}
