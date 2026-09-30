import { readFileSync } from "node:fs";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { AMOUNT_BASE_UNITS, DEVNET_GENESIS, DEVNET_USDC_MINT } from "../src/payment.mjs";

const [orderId, idempotencyKey] = process.argv.slice(2);
const token = process.env.AGENT_API_TOKEN;
const recipient = process.env.FEE_RECIPIENT;
const seedFile = process.env.SOLANA_PAYER_SEED_FILE;
const base = process.env.API_BASE ?? "http://127.0.0.1:8787";
if (!orderId || !idempotencyKey || !token || !recipient) {
  throw new Error("Set AGENT_API_TOKEN and FEE_RECIPIENT, then run: bun scripts/x402-agent.mjs <Duffel test order ID> <UUID>");
}

const headers = { Authorization: `Bearer ${token}` };
const created = await fetch(`${base}/invoices`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ orderId, idempotencyKey }),
});
const invoice = await created.json();
if (!created.ok) throw new Error(`Invoice request: HTTP ${created.status} ${invoice.error}`);
if (invoice.status === "settled") {
  process.stdout.write(`${JSON.stringify(invoice, null, 2)}\n`);
  process.exit(0);
}
if (invoice.status !== "awaiting_payment") throw new Error(`Invoice is ${invoice.status}; check the original payment before retrying`);
if (invoice.recipient !== recipient || invoice.amountBaseUnits !== String(AMOUNT_BASE_UNITS) || invoice.assetMint !== DEVNET_USDC_MINT) {
  throw new Error("Invoice exceeds the agent payment policy");
}
if (!seedFile) throw new Error("Set SOLANA_PAYER_SEED_FILE to pay an unpaid invoice");

const seed = readFileSync(seedFile);
if (seed.length !== 32) throw new Error("SOLANA_PAYER_SEED_FILE must contain exactly 32 raw seed bytes");
const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
const client = new x402Client();
client.registerPolicy((_version, requirements) => requirements.filter(({ scheme, network, asset, amount, payTo, extra }) =>
  scheme === "exact" &&
  network === `solana:${DEVNET_GENESIS.slice(0, 32)}` &&
  asset === DEVNET_USDC_MINT &&
  amount === String(AMOUNT_BASE_UNITS) &&
  payTo === recipient &&
  extra?.memo === invoice.invoiceId,
));
client.register("solana:*", new ExactSvmScheme(signer));
const paid = await wrapFetchWithPayment(fetch, client)(`${base}/invoices/${invoice.invoiceId}/x402`, { headers });
const result = await paid.json();
if (!paid.ok) throw new Error(`x402 payment: HTTP ${paid.status} ${result.error ?? "payment_failed"}`);
if (result.status === "payment_outcome_unknown") {
  throw new Error(`x402 payment outcome is unknown; read GET /invoices/${invoice.invoiceId} or POST its /recover route with the signature. Do not pay again.`);
}
if (result.invoiceId !== invoice.invoiceId || result.status !== "settled") {
  throw new Error("x402 settlement did not return a matching receipt");
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
