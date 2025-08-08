# FCT Auto-Miner Production Setup

## Installation

```bash
# Install dependencies (including SQLite)
pnpm install

# On macOS, you may need Xcode command line tools:
xcode-select --install
```

## Quick Start

### Basic Auto-Mining

```bash
# Start with economical strategy (default)
pnpm auto

# Basic auto-mining (smart mode)
pnpm auto --max-cost 0.0005 --budget 0.01

# The only metric that matters is cost per FCT!

# Mine during specific hours (2-6 AM and 2-6 PM)
pnpm auto -H 2-6,14-18

# Set daily budget
pnpm auto --budget 0.1 --target 5000
```

### Mining Strategies (Simplified!)

- **auto** (default) - Smart mode that maximizes efficiency within your budget
- **arbitrage** - Only mines when cheaper than buying on DEX

### View Predefined Profiles

```bash
pnpm auto:profiles
```

Example commands:
- **Basic**: `pnpm auto --max-cost 0.0005 --budget 0.01`
- **Conservative**: `pnpm auto --max-cost 0.0003 --budget 0.005`
- **Night Mining**: `pnpm auto -H 2-6 --budget 0.02`
- **Arbitrage Only**: `pnpm auto --strategy arbitrage --interval 10`

### Analytics

```bash
# View all-time statistics
pnpm auto:analyze

# Analyze specific session
pnpm auto:analyze --session 1

# Show last 20 transactions
pnpm auto:analyze --last 20
```

## All CLI Options

```bash
pnpm auto --help

Options:
  -s, --strategy <type>         Mining strategy: auto or arbitrage (default: "auto")
  -c, --max-cost <usd>         Maximum cost per FCT in USD (the key metric!)
  -e, --min-efficiency <percent> Minimum mining efficiency percentage
  -H, --hours <range>          Hours to mine (e.g., '2-6,14-18')
  -b, --budget <eth>           Daily budget in ETH
  -t, --target <fct>           Target FCT amount to mine
  -i, --interval <seconds>     Check interval in seconds (default: 30)
  -m, --max-size <kb>          Maximum data size in KB (default: 100)
```

## Features

### Auto-Mining Rules
- **Cost threshold** - Only mine when cost per FCT is below target (THE key metric)
- **Efficiency threshold** - Only mine when efficiency > target %
- **Schedule** - Mine during specific hours of the day
- **Budget limit** - Stop after spending daily budget
- **Target amount** - Stop after mining target FCT
- **Budget-aware sizing** - Automatically adjusts data size to fit remaining budget

### Persistence & Recovery
- JSON file storage - no database dependencies!
- Session state persists across restarts
- Crash recovery resumes from last state
- Human-readable data in `./mining-data/mining.json`

### Safety Features
- Graceful shutdown on SIGINT/SIGTERM
- Transaction retry with gas escalation
- Nonce management for pending transactions
- L1 receipt verification for actual costs

### Analytics Engine
- Cost per FCT tracking
- Efficiency analysis
- Best/worst transaction identification
- Optimal hour recommendations
- ROI and break-even calculations
- Strategy recommendations

## Data Storage

All mining data is stored in `./mining-data/mining.json`:
- All mining sessions
- Transaction history  
- Runtime state for recovery
- Performance analytics

The JSON file is human-readable and can be edited if needed.

## Production Tips

1. **Focus on Cost/FCT**: This is the ONLY metric that matters for profitability
2. **Set a Budget**: Always use `--budget` to limit exposure
3. **Monitor Performance**: Use `pnpm auto:analyze` regularly
4. **Use Schedules**: Mine during off-peak hours with `-H`
5. **Keep it Simple**: Just use auto mode with cost and budget limits

## Troubleshooting

### Permission Errors
```bash
chmod +x auto-mine-cli.ts
```

### Data Issues
- Check `./mining-data/mining.json` is valid JSON
- Delete the file to start fresh if corrupted
- Only run one auto-miner instance at a time

## Critical Fixes Applied

1. **DEX Orientation** - Dynamically determines WETH/FCT positions
2. **L1 Receipt Tracking** - Uses actual gas burned from receipts
3. **BaseFee for FCT** - Uses baseFeePerGas (not gasPrice) for FCT calculations
4. **Native FCT** - Reads from tx.mint field (not ERC-20 events)

## Environment Variables

Required in `.env`:
```
PRIVATE_KEY=your_private_key_here
GAS_PRICE_MULTIPLIER=1.5
```

## Safety Warning

⚠️ **This tool spends real ETH**. Always:
- Test on Sepolia first
- Start with small amounts
- Monitor closely
- Use budget limits
- Keep private keys secure