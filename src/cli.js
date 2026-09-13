import fs from "node:fs";
import path from "node:path";
import { BitLynesChain } from "./blockchain.js";
import { generateWallet } from "./crypto.js";
import { JsonStore } from "./store.js";

const DATA_FILE =
  process.env.BITLYNES_DATA ??
  path.resolve("data", "chain.json");

function args() {
  const result = {};
  const raw = process.argv.slice(3);

  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i].startsWith("--")) {
      result[raw[i].slice(2)] = raw[i + 1] ?? true;
      i += 1;
    }
  }

  return result;
}

function loadChain() {
  const store = new JsonStore(DATA_FILE);
  const state = store.load();
  const chain = new BitLynesChain({ state });
  return { chain, store };
}

function readWallet(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function usage() {
  console.log(`
BitLynes CLI

  node src/cli.js wallet --save alice.json
  node src/cli.js balance --wallet alice.json
  node src/cli.js mine --wallet alice.json
  node src/cli.js send --from alice.json --to LYN... --amount 5
  node src/cli.js chain
`);
}

const command = process.argv[2];
const options = args();

try {
  if (command === "wallet") {
    const wallet = generateWallet();
    if (options.save) {
      fs.writeFileSync(path.resolve(options.save), JSON.stringify(wallet, null, 2));
      console.log(`Wallet saved to ${path.resolve(options.save)}`);
      console.log(`Address: ${wallet.address}`);
    } else {
      console.log(JSON.stringify(wallet, null, 2));
    }
  } else if (command === "balance") {
    const wallet = readWallet(options.wallet);
    const { chain } = loadChain();
    console.log(`${chain.getBalance(wallet.address)} LYN`);
  } else if (command === "mine") {
    const wallet = readWallet(options.wallet);
    const { chain, store } = loadChain();
    const block = chain.minePending(wallet.address);
    store.save(chain.exportState());
    console.log(`Mined block ${block.index}: ${block.hash}`);
    console.log(`Reward: ${block.rewardUnits / 1e8} LYN`);
  } else if (command === "send") {
    const wallet = readWallet(options.from);
    const { chain, store } = loadChain();
    const lyne = chain.createAndSubmitLyne({
      privateKey: wallet.privateKey,
      to: options.to,
      amount: Number(options.amount),
    });
    store.save(chain.exportState());
    console.log(`Created Lyne ${lyne.id}`);
    console.log(`${lyne.amount} LYN -> ${lyne.to}`);
  } else if (command === "chain") {
    const { chain } = loadChain();
    console.log(JSON.stringify(chain.exportState(), null, 2));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
