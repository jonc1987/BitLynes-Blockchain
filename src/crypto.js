import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function generateWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const publicKeyDer = publicKey.export({
    type: "spki",
    format: "der",
  });

  const privateKeyDer = privateKey.export({
    type: "pkcs8",
    format: "der",
  });

  return {
    address: addressFromPublicKey(publicKeyDer.toString("base64")),
    publicKey: publicKeyDer.toString("base64"),
    privateKey: privateKeyDer.toString("base64"),
  };
}

export function addressFromPublicKey(publicKeyBase64) {
  return `LYN${sha256(Buffer.from(publicKeyBase64, "base64")).slice(0, 40)}`;
}

export function publicKeyFromPrivateKey(privateKeyBase64) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    type: "pkcs8",
    format: "der",
  });

  return createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
}

export function signPayload(privateKeyBase64, payload) {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    type: "pkcs8",
    format: "der",
  });

  return sign(
    null,
    Buffer.from(stableStringify(payload)),
    privateKey
  ).toString("base64");
}

export function verifyPayload(publicKeyBase64, payload, signatureBase64) {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      type: "spki",
      format: "der",
    });

    return verify(
      null,
      Buffer.from(stableStringify(payload)),
      publicKey,
      Buffer.from(signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}
