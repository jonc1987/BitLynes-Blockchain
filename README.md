# BitLynes

**BitLynes** is a working educational cryptocurrency/blockchain prototype.

The core idea is simple:

> You create a **Lyne** — a signed instruction carrying an amount of LYN — and send that Lyne to someone else's BitLynes address.

A Lyne is the BitLynes equivalent of a transaction.

## Features

- Native currency: **LYN**
- Wallet generation with Ed25519 public/private keys
- Address generation from public keys
- Signed **Lynes**
- Balance and nonce validation
- Mempool
- Proof-of-work blocks
- Mining rewards
- Blockchain validation
- JSON persistence
- REST API
- Browser dashboard
- CLI tools
- Automated tests

## Important

This is a **prototype/test blockchain**, not production financial software.

The demo HTTP API can create wallets and can accept a private key when creating a Lyne. That makes local testing convenient, but a production wallet should sign locally and should never send a private key to a server.

## Quick start

```bash
npm install
npm start
```

Open:

```text
http://localhost:4242
```

The default API/node port is `4242`.

## First transfer

### 1. Create two wallets

```bash
npm run wallet -- --save alice.json
npm run wallet -- --save bob.json
```

### 2. Mine LYN for Alice

```bash
npm run mine -- --wallet alice.json
```

### 3. Check Alice's balance

```bash
npm run balance -- --wallet alice.json
```

### 4. Create and broadcast a Lyne to Bob

```bash
npm run send -- --from alice.json --to <BOB_ADDRESS> --amount 5
```

### 5. Mine the pending Lyne into a block

```bash
npm run mine -- --wallet alice.json
```

## What is a Lyne?

A Lyne contains:

```json
{
  "id": "hash...",
  "from": "sender address",
  "to": "recipient address",
  "amount": 5,
  "nonce": 1,
  "timestamp": 0,
  "publicKey": "sender public key",
  "signature": "sender signature"
}
```

The signature proves the Lyne was created by the owner of the sender address.

## API

### Node info

```http
GET /api/info
```

### Chain

```http
GET /api/chain
```

### Pending Lynes

```http
GET /api/lynes
```

### Balance

```http
GET /api/balance/:address
```

### Create a demo wallet

```http
POST /api/wallet
```

### Create + submit a Lyne

```http
POST /api/lynes
Content-Type: application/json

{
  "privateKey": "<PKCS8 DER base64>",
  "to": "<recipient address>",
  "amount": 5
}
```

### Mine a block

```http
POST /api/mine
Content-Type: application/json

{
  "minerAddress": "<address>"
}
```

### Validate chain

```http
GET /api/validate
```

## Network model

This first version is a single-node blockchain implementation. The next logical step is adding:

- peer discovery
- block/transaction gossip
- chain synchronization
- fork choice
- multi-node consensus
- browser-side signing
- encrypted wallet files
- smart contracts or programmable Lynes
- a block explorer
- a testnet

## Currency model

- Symbol: `LYN`
- Block reward: `25 LYN`
- Max decimal precision: 8 places
- Mining difficulty: configurable
- Transfers are account/balance based

## License

MIT
