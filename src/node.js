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

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/info", (req, res) => {
  res.json({
    name: "BitLynes",
    symbol: "LYN",
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

app.post("/api/wallet", (req, res) => {
  res.status(201).json({
    ...generateWallet(),
    warning:
      "Demo wallet. Store the private key safely. Production wallets should sign locally.",
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

app.get("/api/validate", (req, res) => {
  res.json(chain.validateChain());
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
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
