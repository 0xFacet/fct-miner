import chalk from "chalk";
import { readFileSync } from "fs";
import { join } from "path";

// Get version from package.json
function getVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, "package.json"), "utf8")
  );
  return packageJson.version;
}

const VERSION = getVersion();

// Enhanced logging functions to replace console.log calls
export const ui = {
  // Clear screen and show animated header
  showHeader: (network?: string, wallet?: string) => {
    console.clear();

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
  },

  showSystemInfo: (
    network?: string,
    wallet?: string,
    balance?: string,
    ethPrice?: number,
    balanceUsd?: number
  ) => {
    console.log(chalk.cyan("System Info:"));

    if (network) {
      console.log(`  Network: ${chalk.yellow.bold(network)}`);
    }

    if (wallet) {
      console.log(`  Wallet: ${chalk.white(wallet)}`);
    }

    if (balance) {
      console.log(`  Balance: ${chalk.green.bold(balance + " ETH")}`);
    }

    if (ethPrice) {
      console.log(
        `  ETH Price: ${chalk.green.bold("$" + ethPrice.toFixed(2))}`
      );
    }

    if (balanceUsd) {
      console.log(
        `  Balance USD: ${chalk.yellow.bold("$" + balanceUsd.toFixed(2))}`
      );
    }

    console.log("");
  },

  showMiningOptions: () => {
    console.log(chalk.cyan("Select Mining Size:"));
    console.log(chalk.gray("Choose how much calldata to use per transaction:"));
    console.log("");
  },

  showMiningSelection: (label: string, size: string) => {
    console.log(
      `${chalk.green("Selected:")} ${chalk.white.bold(
        label + " (" + size + ") mining"
      )}`
    );
    console.log("");
  },

  showSpendingOptions: (costEth: string, costUsd: string) => {
    console.log(chalk.cyan("Spending Options:"));
    console.log(
      chalk.gray(`Each transaction will cost ~${costEth} ETH (${costUsd})`)
    );
    console.log(
      `  ${chalk.yellow("1.")} ${chalk.white("Spend ALL ETH in wallet")}`
    );
    console.log(`  ${chalk.yellow("2.")} ${chalk.white("Set a spending cap")}`);
    console.log("");
  },

  showSpendingChoice: (choice: string, details?: string) => {
    if (choice === "all") {
      console.log(
        `${chalk.green("Will spend ALL ETH")} ${chalk.gray(details || "")}`
      );
    } else {
      console.log(
        `${chalk.green("Will spend up to")} ${chalk.yellow.bold(details || "")}`
      );
    }
    console.log("");
  },
};

export default ui;
