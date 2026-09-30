import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { DEVNET_GENESIS, DEVNET_USDC_MINT } from "./payment.mjs";

const directory = mkdtempSync(join(tmpdir(), "flightsweeper-x402-"));
const path = join(directory, "invoices.sqlite");
const token = "test-agent-token-with-more-than-32-characters";
const invoiceId = "fee_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipient = "8X39qt9Di4MtoAc1E2qV5tAtvWrbgAek1G7dHBYHcGBq";
process.env.DUFFEL_TEST_TOKEN = "duffel_test_fixture";
process.env.AGENT_API_TOKEN = token;
process.env.FEE_RECIPIENT = recipient;
process.env.DB_PATH = path;
const payer = "7ZPJhZfjtNxZBVgP7YAFhBPpQ8QCkaQ9HDVNTM5FXXQv";
const recoverySignature = "5".repeat(88);
const balance = (accountIndex, owner, amount) => ({
  accountIndex, owner, mint: DEVNET_USDC_MINT, uiTokenAmount: { amount: String(amount), decimals: 6 },
});
const recoveryTransaction = {
  meta: {
    err: null,
    preTokenBalances: [balance(1, recipient, 0), balance(2, payer, 20_000)],
    postTokenBalances: [balance(1, recipient, 10_000), balance(2, payer, 10_000)],
  },
  transaction: {
    signatures: [recoverySignature],
    message: {
      accountKeys: [{ pubkey: payer }, { pubkey: "recipient-ata" }, { pubkey: "payer-ata" }],
      instructions: [
        { program: "spl-token", parsed: { type: "transferChecked", info: {
          source: "payer-ata", destination: "recipient-ata", mint: DEVNET_USDC_MINT, tokenAmount: { amount: "10000" },
        } } },
        { programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: invoiceId },
      ],
    },
  },
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).endsWith("/supported")) return Response.json({
    kinds: [{ x402Version: 2, scheme: "exact", network: `solana:${DEVNET_GENESIS.slice(0, 32)}`, extra: { feePayer: recipient } }],
    extensions: [],
  });
  if (String(url) === "https://api.devnet.solana.com") {
    const { method } = JSON.parse(options.body);
    const result = method === "getGenesisHash" ? DEVNET_GENESIS : method === "getTransaction" ? recoveryTransaction : [];
    return Response.json({ jsonrpc: "2.0", result, id: 1 });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};
const { handle } = await import("./server.mjs");
const db = new Database(path);
db.query("INSERT INTO invoices (id, order_id, idempotency_key, reference, recipient, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
  invoiceId, "ord_test", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recipient, recipient, new Date().toISOString(),
);
afterAll(() => {
  db.close();
  globalThis.fetch = originalFetch;
  rmSync(directory, { recursive: true, force: true });
});

test("x402 challenge names the exact invoice fee; settled retry returns its receipt", async () => {
  const request = () => new Request(`http://127.0.0.1:8787/invoices/${invoiceId}/x402`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const unpaid = await handle(request());
  expect(unpaid.status).toBe(402);
  const challenge = JSON.parse(Buffer.from(unpaid.headers.get("PAYMENT-REQUIRED"), "base64").toString("utf8"));
  expect(challenge.x402Version).toBe(2);
  expect(challenge.accepts[0]).toMatchObject({
    scheme: "exact", network: `solana:${DEVNET_GENESIS.slice(0, 32)}`, amount: "10000",
    asset: DEVNET_USDC_MINT, payTo: recipient, extra: { memo: invoiceId },
  });

  db.query("UPDATE invoices SET x402_pending_at = ? WHERE id = ?").run(new Date().toISOString(), invoiceId);
  const uncertain = await handle(request());
  expect(uncertain.status).toBe(200);
  expect(uncertain.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(await uncertain.json()).toMatchObject({ status: "payment_outcome_unknown", paymentUrl: null });

  db.query("UPDATE invoices SET signature = ?, payer = ?, settled_at = ?, x402_pending_at = NULL WHERE id = ?").run(
    "fixture-transaction", "fixture-payer", new Date().toISOString(), invoiceId,
  );
  const paid = await handle(request());
  expect(paid.status).toBe(200);
  expect(paid.headers.get("PAYMENT-REQUIRED")).toBeNull();
  expect(await paid.json()).toMatchObject({ status: "settled", transactionSignature: "fixture-transaction" });
});

test("bearer prefix is required", async () => {
  const bare = new Request(`http://127.0.0.1:8787/invoices/${invoiceId}`, { headers: { Authorization: token } });
  await expect(handle(bare)).rejects.toMatchObject({ code: "unauthorized" });
});

test("recover settles a pending x402 invoice from a submitted signature", async () => {
  db.query("UPDATE invoices SET signature = NULL, payer = NULL, settled_at = NULL, x402_pending_at = ? WHERE id = ?").run(
    new Date().toISOString(), invoiceId,
  );
  const recovered = await handle(new Request(`http://127.0.0.1:8787/invoices/${invoiceId}/recover`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ signature: recoverySignature }),
  }));
  expect(await recovered.json()).toMatchObject({ status: "settled", transactionSignature: recoverySignature, payer });
  expect(db.query("SELECT x402_pending_at FROM invoices WHERE id = ?").get(invoiceId).x402_pending_at).toBeNull();
});

test("serves video byte ranges for Safari playback", async () => {
  const part = await handle(new Request("http://localhost/demo.mp4", { headers: { Range: "bytes=0-99" } }));
  expect(part.status).toBe(206);
  expect(part.headers.get("Content-Range")).toMatch(/^bytes 0-99\/\d+$/);
  expect((await part.arrayBuffer()).byteLength).toBe(100);
  expect((await handle(new Request("http://localhost/demo.mp4", { headers: { Range: "bytes=999999999-" } }))).status).toBe(416);
});
