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
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).endsWith("/supported")) return Response.json({
    kinds: [{ x402Version: 2, scheme: "exact", network: `solana:${DEVNET_GENESIS.slice(0, 32)}`, extra: { feePayer: recipient } }],
    extensions: [],
  });
  if (String(url) === "https://api.devnet.solana.com") {
    const { method } = JSON.parse(options.body);
    return Response.json({ jsonrpc: "2.0", result: method === "getGenesisHash" ? DEVNET_GENESIS : [], id: 1 });
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
