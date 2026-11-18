import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

// Run locally. Never run in CI, commit the output, or print private values.
// A new directory and exclusive writes prevent accidental key replacement.
const directory = resolve(process.argv[2] || ".local-sync-keys");
const kid = process.argv[3] || "trade-sync-v1";
if (!/^[A-Za-z0-9_-]{1,80}$/.test(kid)) throw new Error("Invalid key ID");
await mkdir(directory, { mode: 0o700 });
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), use: "sig", alg: "RS256", kid }] };
const issuer = "https://www.yanxiao.me";
const audience = "binance-trade-sync";
const files = {
  "beijing.env.json": {
    BINANCE_SYNC_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
    BINANCE_SYNC_KEY_ID: kid, BINANCE_SYNC_ISSUER: issuer, BINANCE_SYNC_AUDIENCE: audience,
    BINANCE_SYNC_URL: "https://yanxiao.me/trade/api/sync",
  },
  "public-jwks.json": jwks,
};
for (const [name, value] of Object.entries(files)) {
  await writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Created ${join(directory, name)}`);
}
