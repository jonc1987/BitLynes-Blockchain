import test from "node:test";
import assert from "node:assert/strict";
import { BitLynesChain } from "../src/blockchain.js";
import { generateWallet } from "../src/crypto.js";

test("mining creates spendable LYN and a Lyne transfers it", () => {
  const chain = new BitLynesChain({ difficulty: 1, reward: 25 });
  const alice = generateWallet();
  const bob = generateWallet();

  chain.minePending(alice.address);
  assert.equal(chain.getBalance(alice.address), 25);

  const lyne = chain.createAndSubmitLyne({
    privateKey: alice.privateKey,
    to: bob.address,
    amount: 7.5,
    minerGroupId: "autominer",
    feePercent: 0.002,
  });

  assert.equal(lyne.from, alice.address);
  assert.equal(lyne.to, bob.address);
  assert.equal(lyne.amount, 7.5);
  assert.equal(lyne.fee, 0.00015);
  assert.equal(chain.getBalance(alice.address, { includeMempool: true }), 17.49985);

  chain.minePending("LYN0000000000000000000000000000000000000000", {
    minerGroupId: "autominer",
    minerGroupName: "AutoMiner",
  });

  assert.equal(chain.getBalance(bob.address), 7.5);
  assert.deepEqual(chain.validateChain(), { valid: true });
});

test("a forged Lyne is rejected", () => {
  const chain = new BitLynesChain({ difficulty: 1 });
  const alice = generateWallet();
  const bob = generateWallet();

  chain.minePending(alice.address);
  const lyne = chain.createLyne({
    privateKey: alice.privateKey,
    to: bob.address,
    amount: 1,
    minerGroupId: "autominer",
    feePercent: 0.002,
  });

  lyne.amountUnits = 999 * 1e8;
  lyne.amount = 999;

  assert.throws(() => chain.submitLyne(lyne));
});

test("overspending including miner fee is rejected", () => {
  const chain = new BitLynesChain({ difficulty: 1 });
  const alice = generateWallet();
  const bob = generateWallet();

  assert.throws(() =>
    chain.createAndSubmitLyne({
      privateKey: alice.privateKey,
      to: bob.address,
      amount: 1,
      minerGroupId: "autominer",
      feePercent: 0.002,
    })
  );
});

test("miner fee is charged to sender and paid to selected miner", () => {
  const chain = new BitLynesChain({ difficulty: 1, reward: 25 });
  const alice = generateWallet();
  const bob = generateWallet();
  const miner = generateWallet();

  chain.minePending(alice.address);
  const tx = chain.createAndSubmitLyne({
    privateKey: alice.privateKey,
    to: bob.address,
    amount: 10,
    minerGroupId: "blue",
    feePercent: 0.5,
  });

  assert.equal(tx.fee, 0.05);
  assert.equal(chain.getBalance(alice.address, { includeMempool: true }), 14.95);

  const block = chain.minePending(miner.address, {
    minerGroupId: "blue",
    minerGroupName: "Blue",
  });

  assert.equal(block.transactions.length, 1);
  assert.equal(chain.getBalance(bob.address), 10);
  assert.equal(chain.getBalance(miner.address), 25.05);
  assert.deepEqual(chain.validateChain(), { valid: true });
});

test("a miner group only processes Lynes assigned to it", () => {
  const chain = new BitLynesChain({ difficulty: 1, reward: 25 });
  const alice = generateWallet();
  const bob = generateWallet();
  const carol = generateWallet();
  const miner = generateWallet();

  chain.minePending(alice.address);
  chain.createAndSubmitLyne({
    privateKey: alice.privateKey,
    to: bob.address,
    amount: 5,
    minerGroupId: "a",
    feePercent: 0.1,
  });
  chain.createAndSubmitLyne({
    privateKey: alice.privateKey,
    to: carol.address,
    amount: 5,
    minerGroupId: "b",
    feePercent: 0.2,
  });

  const block = chain.minePending(miner.address, {
    minerGroupId: "a",
    minerGroupName: "A",
  });

  assert.equal(block.transactions.length, 1);
  assert.equal(block.transactions[0].minerGroupId, "a");
  assert.equal(chain.mempool.length, 1);
  assert.equal(chain.mempool[0].minerGroupId, "b");
  assert.deepEqual(chain.validateChain(), { valid: true });
});

test("later nonce assigned to another miner stays queued until earlier nonce confirms", () => {
  const chain = new BitLynesChain({ difficulty: 1, reward: 25 });
  const alice = generateWallet();
  const bob = generateWallet();
  const carol = generateWallet();
  const minerA = generateWallet();
  const minerB = generateWallet();

  chain.minePending(alice.address);
  chain.createAndSubmitLyne({
    privateKey: alice.privateKey,
    to: bob.address,
    amount: 5,
    minerGroupId: "a",
    feePercent: 0.1,
  });
  chain.createAndSubmitLyne({
    privateKey: alice.privateKey,
    to: carol.address,
    amount: 5,
    minerGroupId: "b",
    feePercent: 0.1,
  });

  const bFirst = chain.minePending(minerB.address, {
    minerGroupId: "b",
    minerGroupName: "B",
  });
  assert.equal(bFirst.transactions.length, 0);
  assert.equal(chain.mempool.length, 2);

  const aBlock = chain.minePending(minerA.address, {
    minerGroupId: "a",
    minerGroupName: "A",
  });
  assert.equal(aBlock.transactions.length, 1);

  const bBlock = chain.minePending(minerB.address, {
    minerGroupId: "b",
    minerGroupName: "B",
  });
  assert.equal(bBlock.transactions.length, 1);
  assert.deepEqual(chain.validateChain(), { valid: true });
});
