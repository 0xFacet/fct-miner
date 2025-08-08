import {
  createPublicClient,
  createWalletClient,
  http,
  type Hash,
  type WalletClient,
  type PublicClient,
  formatEther,
  formatGwei,
  parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendRawFacetTransaction, getFctMintRate } from "@0xfacet/sdk/utils";
import { getNetworkConfig, type NetworkConfig } from "./config";
import { calculateFctOutput } from "./fct-calculator";
import * as dotenv from "dotenv";

dotenv.config();

export type MiningConfig = {
  dataSize: number;
  gasMultiplier?: number;
  maxRetries?: number;
  escalateGas?: boolean;
};

export type MiningResult = {
  l1Hash: string;
  facetHash: string;
  ethBurned: bigint;
  fctMinted: bigint;
  efficiency: number;
  costPerFct: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  baseFeePerGas: bigint;
};

export class MiningEngine {
  private network: NetworkConfig;
  private l1Client: PublicClient;
  private facetClient: PublicClient;
  private wallet: WalletClient;
  private account: ReturnType<typeof privateKeyToAccount>;

  constructor() {
    this.network = getNetworkConfig();
    
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("PRIVATE_KEY not found in .env file");
    }
    
    this.account = privateKeyToAccount(privateKey as `0x${string}`);
    
    this.l1Client = createPublicClient({
      chain: this.network.l1Chain,
      transport: http(this.network.l1RpcUrl),
    });
    
    this.facetClient = createPublicClient({
      chain: this.network.facetChain,
      transport: http(this.network.facetRpcUrl),
    });
    
    this.wallet = createWalletClient({
      account: this.account,
      chain: this.network.l1Chain,
      transport: http(this.network.l1RpcUrl),
    });
  }

  /**
   * Preview mining operation without sending transaction
   */
  async preview(dataSize: number): Promise<{
    estimatedFct: bigint;
    estimatedCost: bigint;
    efficiency: number;
    costPerFct: bigint;
    gasPrice: bigint;
    baseFee: bigint;
  }> {
    const block = await this.l1Client.getBlock();
    const baseFee = block.baseFeePerGas || 0n;
    const gasPrice = await this.l1Client.getGasPrice();
    const mintRate = await getFctMintRate(this.network.l1Chain.id);
    
    const calc = calculateFctOutput({
      dataSize,
      baseFee,
      mintRate,
    });
    
    return {
      estimatedFct: calc.fctMinted,
      estimatedCost: calc.ethBurned,
      efficiency: calc.efficiency,
      costPerFct: calc.costPerFct,
      gasPrice,
      baseFee,
    };
  }

  /**
   * Mine FCT with retry logic and gas escalation
   */
  async mine(config: MiningConfig): Promise<MiningResult> {
    const maxRetries = config.maxRetries ?? 3;
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.attemptMining(config, attempt);
      } catch (error) {
        lastError = error as Error;
        console.log(`Mining attempt ${attempt + 1} failed: ${lastError.message}`);
        
        if (attempt < maxRetries - 1) {
          // Exponential backoff
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
          console.log(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError || new Error("Mining failed");
  }

  private async attemptMining(config: MiningConfig, attempt: number): Promise<MiningResult> {
    const gasMultiplier = config.gasMultiplier ?? (Number(process.env.GAS_PRICE_MULTIPLIER) || 1.5);
    
    // Get current network state
    const [block, gasPrice, mintRate, nonce] = await Promise.all([
      this.l1Client.getBlock(),
      this.l1Client.getGasPrice(),
      getFctMintRate(this.network.l1Chain.id),
      this.l1Client.getTransactionCount({
        address: this.account.address,
        blockTag: "pending",
      }),
    ]);
    
    const baseFee = block.baseFeePerGas || gasPrice;
    
    // Calculate gas parameters with escalation for retries
    let finalGasPrice: bigint;
    if (config.escalateGas && attempt > 0) {
      // Escalate priority fee for retries
      const baseTip = parseGwei("0.25");
      const escalatedTip = baseTip * BigInt(1 + attempt);
      finalGasPrice = baseFee + escalatedTip;
      console.log(`Escalating gas: base=${formatGwei(baseFee)} tip=${formatGwei(escalatedTip)}`);
    } else {
      finalGasPrice = BigInt(Math.floor(Number(gasPrice) * gasMultiplier));
    }
    
    // Build mine boost data
    const mineBoostData = this.buildMineBoost(config.dataSize);
    
    // Send transaction
    console.log(`Sending mining transaction (attempt ${attempt + 1})...`);
    const { l1TransactionHash, facetTransactionHash } = await sendRawFacetTransaction(
      this.network.l1Chain.id,
      this.account.address,
      {
        to: this.account.address,
        value: 0n,
        data: "0x",
        mineBoost: `0x${Buffer.from(mineBoostData).toString("hex")}`,
      },
      async (l1tx) => {
        // Optional: Pre-estimate gas for better accuracy
        const gasEstimate = await this.l1Client.estimateGas({
          ...l1tx,
          account: this.account,
        });
        
        console.log(`Estimated gas: ${gasEstimate.toString()}`);
        
        return this.wallet.sendTransaction({
          ...l1tx,
          account: this.account,
          gasPrice: finalGasPrice,
          nonce,
        });
      }
    );
    
    console.log(`L1 Hash: ${l1TransactionHash}`);
    console.log(`Facet Hash: ${facetTransactionHash}`);
    
    // Wait for L1 confirmation
    const l1Receipt = await this.l1Client.waitForTransactionReceipt({
      hash: l1TransactionHash as Hash,
      timeout: 60_000,
    });
    
    // Get block for baseFee at mining time
    const miningBlock = await this.l1Client.getBlock({
      blockNumber: l1Receipt.blockNumber,
    });
    const actualBaseFee = miningBlock.baseFeePerGas || baseFee;
    
    // Wait for Facet confirmation
    const facetReceipt = await this.facetClient.waitForTransactionReceipt({
      hash: facetTransactionHash as Hash,
      timeout: 60_000,
    });
    
    // Get actual FCT minted from native field
    const facetTx = await this.facetClient.getTransaction({
      hash: facetTransactionHash as Hash,
    });
    
    const actualFctMinted = facetTx && "mint" in facetTx && facetTx.mint
      ? BigInt(facetTx.mint as string | number | bigint)
      : 0n;
    
    // Calculate actual costs
    const actualEthBurned = (l1Receipt.effectiveGasPrice ?? finalGasPrice) * (l1Receipt.gasUsed ?? 0n);
    const actualCostPerFct = actualFctMinted > 0n
      ? (actualEthBurned * 10n ** 18n) / actualFctMinted
      : 0n;
    
    // Calculate efficiency
    const baseExecutionGas = 21000n;
    const calldataGas = (l1Receipt.gasUsed ?? 0n) - baseExecutionGas;
    const efficiency = Number(calldataGas) / Number(l1Receipt.gasUsed ?? 1n) * 100;
    
    return {
      l1Hash: l1TransactionHash,
      facetHash: facetTransactionHash,
      ethBurned: actualEthBurned,
      fctMinted: actualFctMinted,
      efficiency,
      costPerFct: actualCostPerFct,
      gasUsed: l1Receipt.gasUsed ?? 0n,
      effectiveGasPrice: l1Receipt.effectiveGasPrice ?? finalGasPrice,
      baseFeePerGas: actualBaseFee,
    };
  }

  private buildMineBoost(dataSize: number): Uint8Array {
    const overheadBytes = 160;
    const size = Math.max(dataSize - overheadBytes, 0);
    const pattern = new TextEncoder().encode("FACETMINE");
    const buffer = new Uint8Array(size);
    
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = pattern[i % pattern.length];
    }
    
    return buffer;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current network conditions
   */
  async getNetworkConditions() {
    const [block, gasPrice, mintRate] = await Promise.all([
      this.l1Client.getBlock(),
      this.l1Client.getGasPrice(),
      getFctMintRate(this.network.l1Chain.id),
    ]);
    
    return {
      baseFee: block.baseFeePerGas || 0n,
      gasPrice,
      mintRate,
      blockNumber: block.number,
      timestamp: new Date(Number(block.timestamp) * 1000),
    };
  }

  /**
   * Get wallet balance
   */
  async getBalance(): Promise<bigint> {
    return this.l1Client.getBalance({
      address: this.account.address,
    });
  }
}