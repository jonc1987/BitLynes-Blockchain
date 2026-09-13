import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BitLynesChain } from "./blockchain.js";
import { generateWallet } from "./crypto.js";
import { JsonStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4242);
const DATA_FILE =
  process.env.BITLYNES_DATA ??
  path.join(__dirname, "..", "data", "chain.json");

const store = new JsonStore(DATA_FILE);
const savedState = store.load();

const chain = new BitLynesChain({
  difficulty: Number(process.env.BITLYNES_DIFFICULTY ?? 3),
  reward: Number(process.env.BITLYNES_REWARD ?? 25),
  state: savedState,
});

function persist() {
  store.save(chain.exportState());
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function accountActivity(address) {
  const activity = [];

  for (const block of chain.chain) {
    if (block.index > 0 && block.miner === address && (block.rewardUnits ?? 0) > 0) {
      activity.push({
        type: block.faucet ? "faucet" : "mining",
        amount: block.rewardUnits / 1e8,
        timestamp: block.timestamp,
        block: block.index,
        hash: block.hash,
      });
    }

    for (const tx of block.transactions) {
      if (tx.from === address || tx.to === address) {
        activity.push({
          type: tx.from === address ? "sent" : "received",
          amount: tx.amountUnits / 1e8,
          timestamp: tx.timestamp,
          block: block.index,
          id: tx.id,
          from: tx.from,
          to: tx.to,
        });
      }
    }
  }

  for (const tx of chain.mempool) {
    if (tx.from === address || tx.to === address) {
      activity.push({
        type: tx.from === address ? "pending-sent" : "pending-received",
        amount: tx.amountUnits / 1e8,
        timestamp: tx.timestamp,
        id: tx.id,
        from: tx.from,
        to: tx.to,
      });
    }
  }

  return activity.sort((a, b) => b.timestamp - a.timestamp);
}

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/info", (req, res) => {
  res.json({
    name: "BitLynes",
    symbol: "LYN",
    network: "prototype",
    hasMarketValue: false,
    height: chain.chain.length - 1,
    pendingLynes: chain.mempool.length,
    difficulty: chain.difficulty,
    reward: chain.rewardUnits / 1e8,
    latestHash: chain.chain.at(-1).hash,
  });
});

app.get("/api/chain", (req, res) => {
  res.json(chain.chain);
});

app.get("/api/lynes", (req, res) => {
  res.json(chain.mempool);
});

app.get("/api/balance/:address", (req, res) => {
  const { address } = req.params;
  res.json({
    address,
    confirmed: chain.getBalance(address),
    available: chain.getBalance(address, { includeMempool: true }),
    nextNonce: chain.getNextNonce(address),
  });
});

app.get("/api/account/:address", (req, res) => {
  const { address } = req.params;
  res.json({
    address,
    confirmed: chain.getBalance(address),
    available: chain.getBalance(address, { includeMempool: true }),
    nextNonce: chain.getNextNonce(address),
    activity: accountActivity(address),
  });
});

app.post("/api/wallet", (req, res) => {
  res.status(201).json({
    ...generateWallet(),
    warning:
      "Prototype wallet. The browser stores this key locally for convenience; do not use it for real money.",
  });
});

app.post(
  "/api/lynes",
  asyncRoute(async (req, res) => {
    const { privateKey, to, amount } = req.body ?? {};
    const lyne = chain.createAndSubmitLyne({
      privateKey,
      to,
      amount: Number(amount),
    });
    persist();
    res.status(201).json(lyne);
  })
);

app.post(
  "/api/mine",
  asyncRoute(async (req, res) => {
    const { minerAddress } = req.body ?? {};
    const block = chain.minePending(minerAddress);
    persist();
    res.status(201).json(block);
  })
);

app.post(
  "/api/faucet",
  asyncRoute(async (req, res) => {
    const { address } = req.body ?? {};
    const amount = Number(req.body?.amount ?? 100);

    if (!address || typeof address !== "string" || !address.startsWith("LYN")) {
      throw new Error("A valid BitLynes address is required.");
    }

    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      throw new Error("Faucet amount must be between 0 and 1,000,000 LYN.");
    }

    const amountUnits = Math.round(amount * 1e8);
    if (!Number.isSafeInteger(amountUnits)) {
      throw new Error("Faucet amount is too large.");
    }

    // Prototype-only faucet: make an empty auditable block whose reward is the
    // requested test amount. Pending Lynes stay pending and the normal mining
    // reward is restored immediately after the faucet block is created.
    const pending = chain.mempool;
    const normalRewardUnits = chain.rewardUnits;
    chain.mempool = [];
    chain.rewardUnits = amountUnits;

    let block;
    try {
      block = chain.minePending(address);
      block.faucet = true;
      chain.chain[chain.chain.length - 1].faucet = true;
      chain.chain[chain.chain.length - 1].hash = chain.hashBlock(chain.chain[chain.chain.length - 1]);
      block.hash = chain.chain[chain.chain.length - 1].hash;
    } finally {
      chain.rewardUnits = normalRewardUnits;
      chain.mempool = pending;
    }

    persist();
    res.status(201).json({
      address,
      amount: amountUnits / 1e8,
      balance: chain.getBalance(address),
      block,
      note: "Prototype-only LYN faucet. LYN has no assigned market value.",
    });
  })
);

app.get("/api/validate", (req, res) => {
  res.json(chain.validateChain());
});

// Express 5 / path-to-regexp no longer accepts app.get("*").
// A plain middleware fallback safely serves the SPA for any non-API GET route.
app.use((req, res, next) => {
  if (req.method !== "GET") {
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "BitLynes API route not found." });
  }

  return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({
    error: error.message || "BitLynes request failed.",
  });
});

app.listen(PORT, () => {
  console.log(`BitLynes node listening on http://localhost:${PORT}`);
  console.log(`Chain data: ${DATA_FILE}`);
});
