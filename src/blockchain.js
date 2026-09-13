import { sha256, stableStringify, addressFromPublicKey, publicKeyFromPrivateKey, signPayload, verifyPayload } from "./crypto.js";

const DECIMALS = 8;
const UNIT = 10 ** DECIMALS;

function toUnits(amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be a positive number.");
  }

  const units = Math.round(amount * UNIT);
  if (Math.abs(units / UNIT - amount) > 1 / UNIT / 2) {
    throw new Error(`BitLynes supports at most ${DECIMALS} decimal places.`);
  }
  return units;
}

function fromUnits(units) {
  return units / UNIT;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class BitLynesChain {
  constructor({ difficulty = 3, reward = 25, state = null } = {}) {
    this.difficulty = difficulty;
    this.rewardUnits = toUnits(reward);
    this.chain = [];
    this.mempool = [];

    if (state) {
      this.importState(state);
    } else {
      this.chain = [this.createGenesisBlock()];
    }
  }

  createGenesisBlock() {
    const block = {
      index: 0,
      timestamp: 0,
      previousHash: "0".repeat(64),
      nonce: 0,
      difficulty: 0,
      transactions: [],
      miner: "GENESIS",
      minerGroupId: "genesis",
      minerGroupName: "Genesis",
      rewardUnits: 0,
    };

    block.hash = this.hashBlock(block);
    return block;
  }

  hashBlock(block) {
    const { hash, ...payload } = block;
    return sha256(stableStringify(payload));
  }

  lynePayload(lyne) {
    const payload = {
      from: lyne.from,
      to: lyne.to,
      amountUnits: lyne.amountUnits,
      nonce: lyne.nonce,
      timestamp: lyne.timestamp,
      publicKey: lyne.publicKey,
    };

    if ("minerGroupId" in lyne) payload.minerGroupId = lyne.minerGroupId;
    if ("feeUnits" in lyne) payload.feeUnits = lyne.feeUnits;

    return payload;
  }

  lyneId(payload, signature) {
    return sha256(`${stableStringify(payload)}:${signature}`);
  }

  createLyne({ privateKey, to, amount, minerGroupId, feePercent = 0 }) {
    if (!privateKey || !to) {
      throw new Error("privateKey and recipient address are required.");
    }
    if (!minerGroupId || typeof minerGroupId !== "string") {
      throw new Error("A miner group is required.");
    }
    if (!Number.isFinite(feePercent) || feePercent < 0 || feePercent > 25) {
      throw new Error("Miner fee must be between 0% and 25%.");
    }

    const publicKey = publicKeyFromPrivateKey(privateKey);
    const from = addressFromPublicKey(publicKey);

    if (from === to) {
      throw new Error("A Lyne must be sent to a different address.");
    }

    const amountUnits = toUnits(amount);
    const feeUnits = Math.ceil(amountUnits * (feePercent / 100));
    const nonce = this.getNextNonce(from);
    const timestamp = Date.now();

    const payload = {
      from,
      to,
      amountUnits,
      nonce,
      timestamp,
      publicKey,
      minerGroupId,
      feeUnits,
    };

    const signature = signPayload(privateKey, payload);

    return {
      id: this.lyneId(payload, signature),
      ...payload,
      amount: fromUnits(amountUnits),
      fee: fromUnits(feeUnits),
      total: fromUnits(amountUnits + feeUnits),
      signature,
    };
  }

  submitLyne(lyne) {
    this.validateLyne(lyne, { includeMempool: true });
    this.mempool.push(clone(lyne));
    return clone(lyne);
  }

  createAndSubmitLyne(args) {
    return this.submitLyne(this.createLyne(args));
  }

  validateLyne(lyne, { includeMempool = false } = {}) {
    if (!lyne || typeof lyne !== "object") {
      throw new Error("Invalid Lyne.");
    }

    const required = [
      "id", "from", "to", "amountUnits", "nonce",
      "timestamp", "publicKey", "signature",
    ];

    for (const field of required) {
      if (!(field in lyne)) throw new Error(`Lyne is missing ${field}.`);
    }

    if (!Number.isSafeInteger(lyne.amountUnits) || lyne.amountUnits <= 0) {
      throw new Error("Lyne amount is invalid.");
    }

    const feeUnits = lyne.feeUnits ?? 0;
    if (!Number.isSafeInteger(feeUnits) || feeUnits < 0) {
      throw new Error("Lyne fee is invalid.");
    }

    if (!Number.isSafeInteger(lyne.nonce) || lyne.nonce < 1) {
      throw new Error("Lyne nonce is invalid.");
    }

    if (addressFromPublicKey(lyne.publicKey) !== lyne.from) {
      throw new Error("Lyne public key does not match sender address.");
    }

    const payload = this.lynePayload(lyne);

    if (this.lyneId(payload, lyne.signature) !== lyne.id) {
      throw new Error("Lyne ID is invalid.");
    }

    if (!verifyPayload(lyne.publicKey, payload, lyne.signature)) {
      throw new Error("Lyne signature is invalid.");
    }

    const knownIds = new Set(
      this.chain.flatMap((block) => block.transactions.map((tx) => tx.id))
    );

    if (knownIds.has(lyne.id)) throw new Error("Lyne is already confirmed.");
    if (includeMempool && this.mempool.some((tx) => tx.id === lyne.id)) {
      throw new Error("Lyne is already pending.");
    }

    const confirmedNonce = this.getConfirmedNonce(lyne.from);
    let expectedNonce = confirmedNonce + 1;

    if (includeMempool) {
      const senderPending = this.mempool
        .filter((tx) => tx.from === lyne.from)
        .sort((a, b) => a.nonce - b.nonce);

      for (const tx of senderPending) {
        if (tx.nonce !== expectedNonce) {
          throw new Error("Pending Lyne nonce sequence is invalid.");
        }
        expectedNonce += 1;
      }
    }

    if (lyne.nonce !== expectedNonce) {
      throw new Error(`Invalid nonce. Expected ${expectedNonce}.`);
    }

    const availableUnits = this.getBalanceUnits(lyne.from, { includeMempool });
    if (availableUnits < lyne.amountUnits + feeUnits) {
      throw new Error(
        `Insufficient balance. Available: ${fromUnits(availableUnits)} LYN.`
      );
    }

    return true;
  }

  minePending(minerAddress, { minerGroupId = null, minerGroupName = null } = {}) {
    if (!minerAddress || typeof minerAddress !== "string") {
      throw new Error("A miner payout address is required.");
    }

    let selected;
    let remaining;

    if (minerGroupId) {
      selected = this.mempool.filter((tx) => (tx.minerGroupId ?? "legacy") === minerGroupId);
      remaining = this.mempool.filter((tx) => (tx.minerGroupId ?? "legacy") !== minerGroupId);
    } else {
      selected = clone(this.mempool);
      remaining = [];
    }

    const feeUnits = selected.reduce((sum, tx) => sum + (tx.feeUnits ?? 0), 0);

    const block = {
      index: this.chain.length,
      timestamp: Date.now(),
      previousHash: this.chain.at(-1).hash,
      nonce: 0,
      difficulty: this.difficulty,
      transactions: clone(selected),
      miner: minerAddress,
      minerGroupId: minerGroupId ?? "manual",
      minerGroupName: minerGroupName ?? "Manual",
      rewardUnits: this.rewardUnits,
      feeUnits,
    };

    const target = "0".repeat(this.difficulty);
    do {
      block.nonce += 1;
      block.hash = this.hashBlock(block);
    } while (!block.hash.startsWith(target));

    this.chain.push(block);
    this.mempool = remaining;
    return clone(block);
  }

  getBalanceUnits(address, { includeMempool = false } = {}) {
    let balance = 0;

    for (const block of this.chain) {
      if (block.index > 0 && block.miner === address) {
        balance += (block.rewardUnits ?? 0) + (block.feeUnits ?? 0);
      }

      for (const tx of block.transactions) {
        const feeUnits = tx.feeUnits ?? 0;
        if (tx.from === address) balance -= tx.amountUnits + feeUnits;
        if (tx.to === address) balance += tx.amountUnits;
      }
    }

    if (includeMempool) {
      for (const tx of this.mempool) {
        const feeUnits = tx.feeUnits ?? 0;
        if (tx.from === address) balance -= tx.amountUnits + feeUnits;
        if (tx.to === address) balance += tx.amountUnits;
      }
    }

    return balance;
  }

  getBalance(address, options = {}) {
    return fromUnits(this.getBalanceUnits(address, options));
  }

  getConfirmedNonce(address) {
    let highest = 0;
    for (const block of this.chain) {
      for (const tx of block.transactions) {
        if (tx.from === address) highest = Math.max(highest, tx.nonce);
      }
    }
    return highest;
  }

  getNextNonce(address) {
    const pending = this.mempool
      .filter((tx) => tx.from === address)
      .map((tx) => tx.nonce);

    return Math.max(this.getConfirmedNonce(address), ...pending, 0) + 1;
  }

  validateChain() {
    if (this.chain.length === 0) return { valid: false, error: "Chain is empty." };

    const genesis = this.chain[0];
    if (genesis.hash !== this.hashBlock(genesis)) {
      return { valid: false, error: "Genesis block hash mismatch." };
    }

    const balances = new Map();
    const nonces = new Map();
    const ids = new Set();
    const addBalance = (address, delta) =>
      balances.set(address, (balances.get(address) ?? 0) + delta);

    for (let i = 1; i < this.chain.length; i += 1) {
      const block = this.chain[i];
      const previous = this.chain[i - 1];

      if (block.index !== i) return { valid: false, error: `Block ${i} index mismatch.` };
      if (block.previousHash !== previous.hash) {
        return { valid: false, error: `Block ${i} previous hash mismatch.` };
      }
      if (block.hash !== this.hashBlock(block)) {
        return { valid: false, error: `Block ${i} hash mismatch.` };
      }
      if (!block.hash.startsWith("0".repeat(block.difficulty))) {
        return { valid: false, error: `Block ${i} fails proof of work.` };
      }

      let calculatedFees = 0;

      for (const tx of block.transactions) {
        if (ids.has(tx.id)) return { valid: false, error: `Duplicate Lyne ${tx.id}.` };

        const payload = this.lynePayload(tx);
        if (
          addressFromPublicKey(tx.publicKey) !== tx.from ||
          !verifyPayload(tx.publicKey, payload, tx.signature) ||
          this.lyneId(payload, tx.signature) !== tx.id
        ) {
          return { valid: false, error: `Invalid Lyne ${tx.id}.` };
        }

        const expectedNonce = (nonces.get(tx.from) ?? 0) + 1;
        if (tx.nonce !== expectedNonce) {
          return { valid: false, error: `Bad nonce in Lyne ${tx.id}.` };
        }

        const feeUnits = tx.feeUnits ?? 0;
        const spend = tx.amountUnits + feeUnits;
        if ((balances.get(tx.from) ?? 0) < spend) {
          return { valid: false, error: `Overspend in Lyne ${tx.id}.` };
        }

        addBalance(tx.from, -spend);
        addBalance(tx.to, tx.amountUnits);
        calculatedFees += feeUnits;
        nonces.set(tx.from, tx.nonce);
        ids.add(tx.id);
      }

      if ((block.feeUnits ?? 0) !== calculatedFees) {
        return { valid: false, error: `Block ${i} fee total mismatch.` };
      }

      addBalance(block.miner, (block.rewardUnits ?? 0) + calculatedFees);
    }

    return { valid: true };
  }

  exportState() {
    return {
      version: 1,
      difficulty: this.difficulty,
      rewardUnits: this.rewardUnits,
      chain: clone(this.chain),
      mempool: clone(this.mempool),
    };
  }

  importState(state) {
    if (!state || state.version !== 1) {
      throw new Error("Unsupported BitLynes state file.");
    }

    this.difficulty = state.difficulty;
    this.rewardUnits = state.rewardUnits;
    this.chain = clone(state.chain);
    this.mempool = clone(state.mempool ?? []);

    const validation = this.validateChain();
    if (!validation.valid) {
      throw new Error(`Refusing invalid chain state: ${validation.error}`);
    }
  }
}
