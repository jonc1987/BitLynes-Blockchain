import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BitLynesChain } from "./blockchain.js";
import { generateWallet } from "./crypto.js";
import { JsonStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4242);
const DATA_FILE = process.env.BITLYNES_DATA ?? path.join(__dirname, "..", "data", "chain.json");
const MINERS_FILE = process.env.BITLYNES_MINERS ?? path.join(__dirname, "..", "data", "miners.json");

const store = new JsonStore(DATA_FILE);
const minersStore = new JsonStore(MINERS_FILE);
const savedState = store.load();

const chain = new BitLynesChain({
  difficulty: Number(process.env.BITLYNES_DIFFICULTY ?? 3),
  reward: Number(process.env.BITLYNES_REWARD ?? 25),
  state: savedState,
});

const AUTOMINER_ID = "autominer";
const AUTOMINER_FEE_PERCENT = 0.002;
const AUTOMINER_PAYOUT = "LYN0000000000000000000000000000000000000000";

let miners = minersStore.load() ?? {
  version: 1,
  groups: [],
};

function ensureAutoMiner() {
  miners.groups = miners.groups.filter((group) => group.id !== AUTOMINER_ID);
  miners.groups.unshift({
    id: AUTOMINER_ID,
    name: "AutoMiner",
    feePercent: AUTOMINER_FEE_PERCENT,
    payoutAddress: AUTOMINER_PAYOUT,
    system: true,
    createdAt: 0,
    description: "Always-on BitLynes network miner.",
  });
}
ensureAutoMiner();
minersStore.save(miners);

function persistChain() {
  store.save(chain.exportState());
}

function persistMiners() {
  minersStore.save(miners);
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

function minerById(id) {
  return miners.groups.find((group) => group.id === id) ?? null;
}

function minerPublic(group) {
  return {
    id: group.id,
    name: group.name,
    feePercent: group.feePercent,
    payoutAddress: group.payoutAddress,
    system: Boolean(group.system),
    createdAt: group.createdAt,
    description: group.description ?? "",
    queued: chain.mempool.filter((tx) => (tx.minerGroupId ?? "legacy") === group.id).length,
  };
}

function slugId(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "miner";
  let id = base;
  let n = 2;
  while (minerById(id)) id = `${base}-${n++}`;
  return id;
}

function accountActivity(address) {
  const activity = [];

  for (const block of chain.chain) {
    if (block.index > 0 && block.miner === address && (block.rewardUnits ?? 0) > 0) {
      const baseReward = (block.rewardUnits ?? 0) / 1e8;
      const fees = (block.feeUnits ?? 0) / 1e8;
      activity.push({
        type: block.minerGroupId === "faucet" ? "faucet" : "mining",
        amount: baseReward + fees,
        baseReward,
        fees,
        minerGroupName: block.minerGroupName ?? "Miner",
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
          fee: tx.from === address ? (tx.feeUnits ?? 0) / 1e8 : 0,
          minerGroupId: tx.minerGroupId ?? "legacy",
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
        fee: tx.from === address ? (tx.feeUnits ?? 0) / 1e8 : 0,
        minerGroupId: tx.minerGroupId ?? "legacy",
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
  const autoMiner = minerById(AUTOMINER_ID);
  const queued = chain.mempool.some((tx) => tx.minerGroupId === AUTOMINER_ID);
  if (!autoMiner || !queued) return;

  try {
    const block = chain.minePending(autoMiner.payoutAddress, {
      minerGroupId: autoMiner.id,
      minerGroupName: autoMiner.name,
    });
    persistChain();
    console.log(
      `[AutoMiner] block ${block.index} · ${block.transactions.length} Lyne(s) · fees ${(block.feeUnits ?? 0) / 1e8} LYN`
    );
  } catch (error) {
    console.error("[AutoMiner]", error);
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
    miners: miners.groups.length,
  });
});

app.get("/api/chain", (req, res) => res.json(chain.chain));
app.get("/api/lynes", (req, res) => res.json(chain.mempool));

app.get("/api/miners", (req, res) => {
  res.json(miners.groups.map(minerPublic));
});

app.post("/api/miners", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const payoutAddress = String(req.body?.payoutAddress ?? "").trim();
  const feePercent = Number(req.body?.feePercent);

  if (name.length < 2 || name.length > 40) {
    return res.status(400).json({ error: "Miner group name must be 2-40 characters." });
  }
  if (!payoutAddress.startsWith("LYN")) {
    return res.status(400).json({ error: "A BitLynes payout address is required." });
  }
  if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 10) {
    return res.status(400).json({ error: "Miner fee must be between 0% and 10%." });
  }

  const group = {
    id: slugId(name),
    name,
    payoutAddress,
    feePercent: Math.round(feePercent * 1000000) / 1000000,
    system: false,
    createdAt: Date.now(),
    description: String(req.body?.description ?? "").trim().slice(0, 120),
  };

  miners.groups.push(group);
  persistMiners();
  res.status(201).json(minerPublic(group));
});

app.delete("/api/miners/:id", (req, res) => {
  const group = minerById(req.params.id);
  if (!group) return res.status(404).json({ error: "Miner group not found." });
  if (group.system) return res.status(400).json({ error: "AutoMiner cannot be deleted." });
  if (chain.mempool.some((tx) => tx.minerGroupId === group.id)) {
    return res.status(400).json({ error: "This miner still has queued Lynes." });
  }
  miners.groups = miners.groups.filter((item) => item.id !== group.id);
  persistMiners();
  res.json({ deleted: true, id: group.id });
});

app.post("/api/miners/:id/mine", (req, res) => {
  const group = minerById(req.params.id);
  if (!group) return res.status(404).json({ error: "Miner group not found." });
  if (group.system) {
    return res.status(400).json({ error: "AutoMiner runs automatically." });
  }

  const queued = chain.mempool.filter((tx) => tx.minerGroupId === group.id);
  if (queued.length === 0) {
    return res.status(400).json({ error: "This miner group has no queued Lynes." });
  }

  const block = chain.minePending(group.payoutAddress, {
    minerGroupId: group.id,
    minerGroupName: group.name,
  });
  persistChain();
  res.status(201).json(block);
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
    warning: "Prototype wallet. This browser stores the private key locally; do not use it for real money.",
  });
});

app.post(
  "/api/lynes",
  asyncRoute(async (req, res) => {
    const { privateKey, to, amount, minerGroupId } = req.body ?? {};
    const miner = minerById(minerGroupId);
    if (!miner) throw new Error("Choose a valid miner group.");

    const lyne = chain.createAndSubmitLyne({
      privateKey,
      to,
      amount: Number(amount),
      minerGroupId: miner.id,
      feePercent: miner.feePercent,
    });
    persistChain();

    res.status(201).json({
      ...lyne,
      miner: minerPublic(miner),
    });
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
    if (!Number.isSafeInteger(amountUnits)) throw new Error("Faucet amount is too large.");

    const pending = chain.mempool;
    const normalRewardUnits = chain.rewardUnits;
    chain.mempool = [];
    chain.rewardUnits = amountUnits;

    let block;
    try {
      block = chain.minePending(address, {
        minerGroupId: "faucet",
        minerGroupName: "Test Faucet",
      });
    } finally {
      chain.rewardUnits = normalRewardUnits;
      chain.mempool = pending;
    }

    persistChain();
    res.status(201).json({
      address,
      amount: amountUnits / 1e8,
      balance: chain.getBalance(address),
      block,
      note: "Prototype-only LYN faucet. LYN has no assigned market value.",
    });
  })
);

app.get("/api/validate", (req, res) => res.json(chain.validateChain()));

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "BitLynes API route not found." });
  }
  return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(400).json({ error: error.message || "BitLynes request failed." });
});

app.listen(PORT, () => {
  console.log(`BitLynes node listening on http://localhost:${PORT}`);
  console.log(`Chain data: ${DATA_FILE}`);
  console.log(`Miner groups: ${MINERS_FILE}`);
});
