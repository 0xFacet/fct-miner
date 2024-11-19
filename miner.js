const readline = require("readline");
const { walletL1FacetActions, createFacetPublicClient } = require("@0xfacet/sdk/viem");
const { privateKeyToAccount } = require("viem/accounts");
const { createWalletClient, http, formatEther, zeroAddress, maxUint256 } = require("viem"); // Added formatEther import
const { sepolia } = require("viem/chains");
require("dotenv").config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const ETH_THRESHOLD = BigInt(process.env.ETH_THRESHOLD || "5000000000000000"); // Default to 0.005 ETH

async function getBalance(walletClient) {
  try {
    const balance = await walletClient.request({
      method: "eth_getBalance",
      params: [walletClient.account.address, "latest"],
    });
    console.log(`Current ETH balance: ${BigInt(balance)} wei`);
    return BigInt(balance);
  } catch (error) {
    console.error("Error fetching balance:", error.message);
    return 0n;
  }
}

async function sendTransaction(counter, walletClient) {
  try {
    console.log(`Starting transaction ${counter + 1}...`);

    const params = {
      to: "0x0000000000000000000000000000000000000000",
      data: "0x48756d616e20736f6369657479207368616c6c20626520656e63697068657265642e",
      value: 0n,
      extraData: "0x27298cee04301b63a8b9cc775eaf413a2074277535bc5803044047db98ebe7df27298cee04301b63a8b9cc775eaf413a2074277535bc5803044047db98ebe7df",
    };

    const {
      l1TransactionHash,
      facetTransactionHash,
      fctMintAmount,
      fctMintRate,
    } = await walletClient.sendFacetTransaction(params);

    console.log(`Transaction ${counter + 1} sent successfully!`);
    console.log("L1 Transaction Hash:", l1TransactionHash);
    console.log("Facet Transaction Hash:", facetTransactionHash);

    if (fctMintAmount && fctMintRate) {
      console.log(`FCT Mint Amount: ${Number(formatEther(fctMintAmount)).toFixed(6)} FCT`);
      console.log(`FCT Mint Rate: ${Number(formatEther(fctMintRate)).toFixed(6)} FCT per gas unit`);
    } else {
      console.log("FCT Mint Amount and Mint Rate not available.");
    }
    

    return true;
  } catch (error) {
    console.error(`Error in transaction ${counter + 1}:`, error.message);
    console.error("Stack Trace:", error.stack);
    return false;
  }
}

async function fixedTransactionMode(walletClient, transactionCount) {
  for (let i = 0; i < transactionCount; i++) {
    await sendTransaction(i, walletClient);
  }
  rl.close();
}

async function recursiveTransactionMode(walletClient) {
  let counter = 0;
  while (true) {
    const balance = await getBalance(walletClient);
    if (balance < ETH_THRESHOLD) {
      console.log(
        `Stopping mining: ETH balance is below the threshold (${ETH_THRESHOLD.toString()} wei)`
      );
      break;
    }

    const success = await sendTransaction(counter, walletClient);
    counter++;

    if (!success) {
      console.log("Stopping recursive transactions due to an error.");
      break;
    }

    console.log("Press Ctrl+C to stop or wait for the next transaction...");
  }
  rl.close();
}

function promptUser() {
  rl.question(
    "Do you want to run a set number of transactions (1) or run recursively until stopped or ETH balance is too low (2)? ",
    async (answer) => {
      const PRIVATE_KEY = process.env.PRIVATE_KEY;
      if (!PRIVATE_KEY.startsWith("0x")) {
        console.error("Error: PRIVATE_KEY must include the 0x prefix in .env file.");
        process.exit(1);
      }

      const account = privateKeyToAccount(PRIVATE_KEY);
      const facetPublicClient = createFacetPublicClient(sepolia.id);
      console.log("Account:", account.address);
      const fctBalance = await facetPublicClient.getBalance({ address: account.address });
      console.log("FCT Balance:", fctBalance);
      
      const walletClient = createWalletClient({
        chain: sepolia,
        account: account,
        transport: http(),
      }).extend(walletL1FacetActions);

      if (answer === "1") {
        rl.question("How many transactions would you like to execute? ", async (num) => {
          const transactionCount = parseInt(num, 10);
          if (!isNaN(transactionCount) && transactionCount > 0) {
            await fixedTransactionMode(walletClient, transactionCount);
          } else {
            console.log("Invalid number. Exiting.");
            rl.close();
          }
        });
      } else if (answer === "2") {
        console.log(
          `Starting recursive transaction mode. Transactions will run until you run out of ETH (below ${ETH_THRESHOLD.toString()} wei) or manually stop the script.`
        );
        await recursiveTransactionMode(walletClient);
      } else {
        console.log("Invalid choice. Exiting.");
        rl.close();
      }
    }
  );
}

promptUser();
