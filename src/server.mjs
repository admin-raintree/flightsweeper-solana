import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import {
  AMOUNT_BASE_UNITS,
  DEVNET_GENESIS,
  DEVNET_USDC_MINT,
  isPublicKey,
  newReference,
  PaymentMismatch,
  paymentUrl,
  verifiedPayer,
} from "./payment.mjs";

const DUFFEL_TOKEN = process.env.DUFFEL_TEST_TOKEN;
const AGENT_TOKEN = process.env.AGENT_API_TOKEN;
const RECIPIENT = process.env.FEE_RECIPIENT;
const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? ".data/invoices.sqlite";
const RPC_URL = "https://api.devnet.solana.com";

if (!DUFFEL_TOKEN?.startsWith("duffel_test_")) throw new Error("DUFFEL_TEST_TOKEN must be a Duffel test token");
if (!AGENT_TOKEN || AGENT_TOKEN.length < 32) throw new Error("AGENT_API_TOKEN must have at least 32 characters");
if (!isPublicKey(RECIPIENT)) throw new Error("FEE_RECIPIENT must be a Solana public key");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT is invalid");

mkdirSync(dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new Database(DB_PATH, { create: true });
chmodSync(DB_PATH, 0o600);
db.run("PRAGMA journal_mode = WAL");
db.run(`CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  reference TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signature TEXT UNIQUE,
  payer TEXT,
  settled_at TEXT
)`);

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function response(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function authenticated(request) {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(AGENT_TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function bodyJson(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_json");
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) throw new ApiError(413, "body_too_large");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
}

async function rpc(method, params = []) {
  try {
    const result = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!result.ok) throw new Error("RPC HTTP failure");
    const json = await result.json();
    if (json.error) throw new Error("RPC response failure");
    return json.result;
  } catch {
    throw new ApiError(503, "devnet_verification_unavailable");
  }
}

async function confirmedTestOrder(orderId) {
  let result;
  try {
    result = await fetch(`https://api.duffel.com/air/orders/${orderId}`, {
      headers: { Authorization: `Bearer ${DUFFEL_TOKEN}`, "Duffel-Version": "v2", Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    throw new ApiError(503, "duffel_unavailable");
  }
  if (result.status === 404) throw new ApiError(404, "order_not_found");
  if (!result.ok) throw new ApiError(503, "duffel_unavailable");
  const order = (await result.json()).data;
  if (
    order?.id !== orderId ||
    order.live_mode !== false ||
    order.owner?.iata_code !== "ZZ" ||
    order.cancelled_at !== null ||
    order.payment_status?.awaiting_payment !== false ||
    !order.payment_status?.paid_at ||
    !order.documents?.some((document) => document.type === "electronic_ticket")
  ) {
    throw new ApiError(409, "confirmed_duffel_test_order_required");
  }
}

function invoice(id) {
  return db.query("SELECT * FROM invoices WHERE id = ?").get(id);
}

function receipt(row, status = row.signature ? "settled" : "awaiting_payment") {
  return {
    invoiceId: row.id,
    orderId: row.order_id,
    bookingEnvironment: "duffel_test",
    feeEnvironment: "solana_devnet_test",
    amountBaseUnits: String(AMOUNT_BASE_UNITS),
    amountDisplay: "0.01",
    assetMint: DEVNET_USDC_MINT,
    recipient: row.recipient,
    reference: row.reference,
    status,
    paymentUrl: status === "awaiting_payment" ? paymentUrl(row.recipient, row.reference) : null,
    transactionSignature: row.signature,
    payer: row.payer,
  };
}

async function createInvoice(request) {
  const input = await bodyJson(request);
  if (
    !input ||
    Object.keys(input).sort().join() !== "idempotencyKey,orderId" ||
    !/^ord_[A-Za-z0-9]+$/.test(input.orderId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
  ) {
    throw new ApiError(400, "invalid_request");
  }
  let row = db.query("SELECT * FROM invoices WHERE idempotency_key = ?").get(input.idempotencyKey);
  if (row) {
    if (row.order_id !== input.orderId) throw new ApiError(409, "idempotency_conflict");
    return response(receipt(row), 201);
  }

  await confirmedTestOrder(input.orderId);
  if ((await rpc("getGenesisHash")) !== DEVNET_GENESIS) throw new ApiError(503, "wrong_solana_network");
  const accounts = await rpc("getTokenAccountsByOwner", [
    RECIPIENT,
    { mint: DEVNET_USDC_MINT },
    { encoding: "jsonParsed", commitment: "confirmed" },
  ]);
  if (!accounts?.value?.length) throw new ApiError(503, "recipient_usdc_account_missing");
  db.query(`INSERT OR IGNORE INTO invoices (id, order_id, idempotency_key, reference, recipient, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    `fee_${randomUUID()}`,
    input.orderId,
    input.idempotencyKey,
    newReference(),
    RECIPIENT,
    new Date().toISOString(),
  );
  row = db.query("SELECT * FROM invoices WHERE idempotency_key = ?").get(input.idempotencyKey);
  if (!row) throw new ApiError(409, "order_already_invoiced");
  return response(receipt(row), 201);
}

async function verifySignature(row, signature) {
  if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    throw new ApiError(400, "invalid_signature");
  }
  const transaction = await rpc("getTransaction", [signature, {
    commitment: "confirmed",
    encoding: "jsonParsed",
    maxSupportedTransactionVersion: 0,
  }]);
  if (!transaction) return "pending_confirmation";
  try {
    if (!transaction.transaction?.signatures?.includes(signature)) throw new PaymentMismatch("Signature differs");
    return { signature, payer: verifiedPayer(transaction, row) };
  } catch (error) {
    if (error instanceof PaymentMismatch) throw new ApiError(409, "payment_mismatch");
    throw error;
  }
}

async function reconcile(row, submittedSignature) {
  if (row.signature) return receipt(row);
  if ((await rpc("getGenesisHash")) !== DEVNET_GENESIS) {
    throw new ApiError(503, "wrong_solana_network");
  }
  let payment;
  if (submittedSignature) {
    payment = await verifySignature(row, submittedSignature);
  } else {
    const candidates = await rpc("getSignaturesForAddress", [row.reference, { limit: 10, commitment: "confirmed" }]);
    let pending = false;
    for (const candidate of candidates) {
      if (candidate.err) continue;
      try {
        const found = await verifySignature(row, candidate.signature);
        if (found === "pending_confirmation") pending = true;
        else {
          payment = found;
          break;
        }
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "payment_mismatch")) throw error;
      }
    }
    if (!payment && pending) payment = "pending_confirmation";
  }
  if (!payment) return receipt(row);
  if (payment === "pending_confirmation") return receipt(row, payment);
  try {
    db.query("UPDATE invoices SET signature = ?, payer = ?, settled_at = ? WHERE id = ? AND signature IS NULL").run(
      payment.signature,
      payment.payer,
      new Date().toISOString(),
      row.id,
    );
  } catch {
    throw new ApiError(409, "transaction_already_used");
  }
  return receipt(invoice(row.id));
}

async function handle(request) {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return response({ status: "ok", environment: "solana_devnet_test" });
  }
  if (!authenticated(request)) throw new ApiError(401, "unauthorized");
  if (url.pathname === "/invoices" && request.method === "POST") return createInvoice(request);
  const match = /^\/invoices\/(fee_[0-9a-f-]+)(?:\/(settle))?$/.exec(url.pathname);
  if (!match) throw new ApiError(404, "not_found");
  const row = invoice(match[1]);
  if (!row) throw new ApiError(404, "not_found");
  if (request.method === "GET" && !match[2]) return response(await reconcile(row));
  if (request.method === "POST" && match[2] === "settle") {
    const input = await bodyJson(request);
    if (!input || Object.keys(input).join() !== "signature") throw new ApiError(400, "invalid_request");
    return response(await reconcile(row, input.signature));
  }
  throw new ApiError(405, "method_not_allowed");
}

if (import.meta.main) {
  Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    async fetch(request) {
      try {
        return await handle(request);
      } catch (error) {
        if (error instanceof ApiError) return response({ error: error.code }, error.status);
        process.stderr.write(`${error?.stack ?? error}\n`);
        return response({ error: "internal_error" }, 500);
      }
    },
  });
  process.stdout.write(`FlightSweeper Solana demo listening on http://127.0.0.1:${PORT}\n`);
}
