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

const autoMine = {
  enabled: false,
  minerAddress: null,
  intervalMs: 2000,
  lastMinedAt: null,
  lastBlock: null,
  lastError: null,
  busy: false,
};

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

function autoMineStatus() {
  return {
    enabled: autoMine.enabled,
    minerAddress: autoMine.minerAddress,
    intervalMs: autoMine.intervalMs,
    lastMinedAt: autoMine.lastMinedAt,
    lastBlock: autoMine.lastBlock,
    lastError: autoMine.lastError,
    busy: autoMine.busy,
  };
}

function accountActivity(address) {
  const activity = [];

  for (const block of chain.chain) {
    if (block.index > 0 && block.miner === address && (block.rewardUnits ?? 0) > 0) {
      activity.push({
        type: block.rewardUnits === chain.rewardUnits ? "mining" : "faucet",
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

setInterval(() => {
  if (!autoMine.enabled || autoMine.busy || chain.mempool.length === 0) {
    return;
  }

  if (!autoMine.minerAddress) {
    autoMine.lastError = "AutoMine has no miner address.";
    return;
  }

  autoMine.busy = true;
  autoMine.lastError = null;

  try {
    const block = chain.minePending(autoMine.minerAddress);
    persist();
    autoMine.lastMinedAt = Date.now();
    autoMine.lastBlock = {
      index: block.index,
      hash: block.hash,
      transactions: block.transactions.length,
      reward: (block.rewardUnits ?? 0) / 1e8,
    };
    console.log(
      `[AutoMine] Mined block ${block.index} with ${block.transactions.length} Lyne(s): ${block.hash}`
    );
  } catch (error) {
    autoMine.lastError = error.message || String(error);
    console.error("[AutoMine]", error);
  } finally {
    autoMine.busy = false;
  }
}, 1000).unref();

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
    autoMine: autoMineStatus(),
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

app.get("/api/automine", (req, res) => {
  res.json(autoMineStatus());
});

app.post("/api/automine", (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  const minerAddress = req.body?.minerAddress ?? autoMine.minerAddress;
  const intervalMs = Number(req.body?.intervalMs ?? autoMine.intervalMs);

  if (enabled && (!minerAddress || typeof minerAddress !== "string" || !minerAddress.startsWith("LYN"))) {
    return res.status(400).json({ error: "A valid BitLynes miner address is required to enable AutoMine." });
  }

  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 60000) {
    return res.status(400).json({ error: "AutoMine interval must be between 1 and 60 seconds." });
  }

  autoMine.enabled = enabled;
  autoMine.minerAddress = minerAddress || null;
  autoMine.intervalMs = Math.round(intervalMs);
  autoMine.lastError = null;

  res.json(autoMineStatus());
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

    const pending = chain.mempool;
    const normalRewardUnits = chain.rewardUnits;
    chain.mempool = [];
    chain.rewardUnits = amountUnits;

    let block;
    try {
      block = chain.minePending(address);
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
