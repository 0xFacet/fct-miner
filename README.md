# FCT Miner

An interactive FCT token miner with real-time dashboard interface for both mainnet and Sepolia testnet.

## Quick Start

1. **Install Dependencies**

   ```bash
   pnpm install
   ```

2. **Configure Wallet**

   - Add your private key to `.env` file:

   ```bash
   PRIVATE_KEY=0x... # Your wallet private key
   NETWORK=sepolia   # or mainnet

   # Optional: Gas price multiplier (default: 1.5 = 50% buffer)
   # GAS_PRICE_MULTIPLIER=1.5  # 50% buffer for faster confirmation
   ```

3. **Fund Wallet**

   - **Sepolia**: Get test ETH from [sepoliafaucet.com](https://sepoliafaucet.com/)
   - **Mainnet**: Send real ETH to your wallet address

4. **Start Mining**

   ```bash
   # Mine on current network
   pnpm mine

   # Mine on specific networks
   pnpm mine:sepolia
   pnpm mine:mainnet
   ```

## Available Commands

### Mining Commands

The unified `pnpm mine` command supports both **interactive** and **autonomous** mining modes:

#### Interactive Mode (Default)

```bash
pnpm mine              # Interactive mining with prompts
pnpm mine:sepolia      # Switch to Sepolia + interactive mine
pnpm mine:mainnet      # Switch to mainnet + interactive mine

# Skip prompts with flags
pnpm mine --budget 0.01              # Skip spending cap prompt
pnpm mine --max-size 50              # Skip size selection prompt
pnpm mine --budget 0.01 --max-size 25  # Skip both prompts
```

#### Autonomous Mode (Advanced)

```bash
# Basic autonomous mining
pnpm mine --max-cost-usd 0.0005 --budget 0.01

# Night mining (2-6 AM)
pnpm mine --hours 2-6 --budget 0.02

# Target-based mining
pnpm mine --target 5000 --max-cost-usd 0.0004

# Arbitrage strategy (only mine when cheaper than DEX)
pnpm mine --strategy arbitrage --interval 10
```

#### Analytics & Profiles

```bash
pnpm mine --analyze    # Show mining analytics
pnpm mine --profiles   # Show example configurations
pnpm mine --help       # Show all available options
```

### Network Management

```bash
pnpm network           # Interactive network switcher
pnpm network:show      # Show current network
pnpm network:sepolia   # Switch to Sepolia testnet
pnpm network:mainnet   # Switch to mainnet
```

### Other Tools

```bash
pnpm swap              # FCT swapping (mainnet only)
pnpm l2hash            # L1 to L2 hash conversion utility
```

## Mining Options & Flags

### Available Flags

| Flag                             | Description                         | Example                 |
| -------------------------------- | ----------------------------------- | ----------------------- |
| `-s, --strategy <type>`          | Mining strategy (auto/arbitrage)    | `--strategy arbitrage`  |
| `-c, --max-cost-usd <usd>`       | Maximum cost per FCT in USD         | `--max-cost-usd 0.0005` |
| `-e, --min-efficiency <percent>` | Minimum mining efficiency %         | `--min-efficiency 85`   |
| `-H, --hours <range>`            | Hours to mine (enables autonomous)  | `--hours 2-6,14-18`     |
| `-b, --budget <eth>`             | Daily budget in ETH                 | `--budget 0.01`         |
| `-t, --target <fct>`             | Target FCT amount to mine           | `--target 5000`         |
| `-i, --interval <seconds>`       | Check interval (enables autonomous) | `--interval 30`         |
| `-m, --max-size <kb>`            | Maximum data size in KB             | `--max-size 50`         |
| `--analyze`                      | Show analytics after completion     | `--analyze`             |
| `--profiles`                     | Show mining profile examples        | `--profiles`            |

### Mining Strategies

- **auto** (default): Smart mode that maximizes efficiency within your budget
- **arbitrage**: Only mines when cheaper than buying FCT on DEX

### Mode Detection

- **Interactive Mode**: Default behavior with prompts (unless autonomous flags used)
- **Autonomous Mode**: Automatically enabled when using `--hours` or `--interval`

## Network Configuration

The miner automatically adapts to the selected network:

### Sepolia Testnet

- **Purpose**: Testing and development
- **ETH Source**: [sepoliafaucet.com](https://sepoliafaucet.com/)
- **Features**: Lower gas costs, no trading pairs
- **Explorer**: [sepolia.explorer.facet.org](https://sepolia.explorer.facet.org)

### Mainnet

- **Purpose**: Production mining
- **ETH Source**: Real ETH required
- **Features**: Full functionality, trading, price data
- **Explorer**: [explorer.facet.org](https://explorer.facet.org)

## Environment Variables

```bash
# Required
PRIVATE_KEY=0x...         # Your wallet private key

# Network Configuration
NETWORK=sepolia           # Options: mainnet, sepolia

# Optional: Gas price multiplier for faster confirmation
GAS_PRICE_MULTIPLIER=1.5 # Default: 1.5 (50% buffer)

# Optional RPC Overrides
L1_RPC_URL=...           # Custom L1 RPC endpoint
FACET_RPC_URL=...        # Custom Facet RPC endpoint
```

## How It Works

1. **Data Generation**: Creates optimized mining data payload
2. **Gas Estimation**: Calculates L1 gas costs and FCT rewards
3. **Price Analysis**: Fetches current ETH price from [eth-price.facet.org](https://eth-price.facet.org)
4. **Transaction Execution**: Sends L1 transaction to Facet inbox
5. **Confirmation**: Waits for both L1 and Facet confirmations

## Dashboard Interface

The miner features a real-time dashboard that displays:

- **System Information**: Network, wallet address (full for easy copying), balance, ETH price
- **Mining Progress**: Live transaction counter, total ETH spent, FCT minted
- **Current Transaction**: Status updates (preparing → submitting → confirming → completed)
- **Statistics**: Mining rate, average cost per FCT, estimated time remaining
- **Interactive Elements**: Clickable transaction hashes that open in block explorer

## Features

- ✅ **Interactive Dashboard**: Real-time mining statistics and progress tracking
- ✅ **Clean Terminal Interface**: Live updates with color-coded status
- ✅ **Clickable Transaction Hashes**: Command+click to open in block explorer
- ✅ **Multi-Network Support**: Seamless mainnet/testnet switching
- ✅ **Real-Time Pricing**: Live ETH price from Facet API
- ✅ **Gas Optimization**: Efficient 95%+ mining efficiency
- ✅ **Market Analysis**: Cost comparisons and FDV calculations
- ✅ **Trading Integration**: Swap vs mine comparisons (mainnet)
- ✅ **Robust Error Handling**: Fallbacks and timeout management
- ✅ **Flexible Mining Sizes**: Choose from preset options or custom sizes
- ✅ **Spending Controls**: Set spending caps or use entire wallet balance

## Mining Economics

The miner calculates:

- **FCT Rewards**: Based on L1 calldata gas consumption
- **Mining Costs**: ETH burned for transaction fees
- **Efficiency**: Percentage of gas generating FCT vs overhead
- **Market Metrics**: Cost per FCT, Fully Diluted Valuation

## Requirements

- Node.js 18+
- pnpm (recommended) or npm
- ETH for gas fees (testnet or mainnet)
