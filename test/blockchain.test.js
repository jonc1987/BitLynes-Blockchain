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
  });

  assert.equal(lyne.from, alice.address);
  assert.equal(lyne.to, bob.address);
  assert.equal(lyne.amount, 7.5);
  assert.equal(chain.getBalance(alice.address, { includeMempool: true }), 17.5);

  chain.minePending(alice.address);

  assert.equal(chain.getBalance(alice.address), 42.5);
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
  });

  lyne.amountUnits = 999 * 1e8;
  lyne.amount = 999;

  assert.throws(() => chain.submitLyne(lyne));
});

test("overspending is rejected", () => {
  const chain = new BitLynesChain({ difficulty: 1 });
  const alice = generateWallet();
  const bob = generateWallet();

  assert.throws(() =>
    chain.createAndSubmitLyne({
      privateKey: alice.privateKey,
      to: bob.address,
      amount: 1,
    })
  );
});
