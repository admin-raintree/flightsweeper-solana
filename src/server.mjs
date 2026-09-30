import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
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
const HOST = process.env.HOST ?? "127.0.0.1";
const DB_PATH = process.env.DB_PATH ?? ".data/invoices.sqlite";
const RPC_URL = "https://api.devnet.solana.com";
const X402_NETWORK = `solana:${DEVNET_GENESIS.slice(0, 32)}`;
const x402Server = registerExactSvmScheme(new x402ResourceServer(new HTTPFacilitatorClient({ timeoutMs: 8_000 })));
let x402Ready;

if (!DUFFEL_TOKEN?.startsWith("duffel_test_")) throw new Error("DUFFEL_TEST_TOKEN must be a Duffel test token");
if (!AGENT_TOKEN || AGENT_TOKEN.length < 32) throw new Error("AGENT_API_TOKEN must have at least 32 characters");
if (!isPublicKey(RECIPIENT)) throw new Error("FEE_RECIPIENT must be a Solana public key");
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT is invalid");
if (!["127.0.0.1", "0.0.0.0"].includes(HOST)) throw new Error("HOST is invalid");

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
  settled_at TEXT,
  x402_pending_at TEXT
)`);
if (!db.query("PRAGMA table_info(invoices)").all().some((column) => column.name === "x402_pending_at")) {
  db.run("ALTER TABLE invoices ADD COLUMN x402_pending_at TEXT");
}

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
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const left = Buffer.from(header.slice(7));
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

async function assertDevnet() {
  if ((await rpc("getGenesisHash")) !== DEVNET_GENESIS) throw new ApiError(503, "wrong_solana_network");
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

function settle(row, payment) {
  try {
    db.query("UPDATE invoices SET signature = ?, payer = ?, settled_at = ?, x402_pending_at = NULL WHERE id = ? AND signature IS NULL").run(
      payment.signature, payment.payer, new Date().toISOString(), row.id,
    );
  } catch {
    throw new ApiError(409, "transaction_already_used");
  }
  return invoice(row.id);
}

function receipt(row, status = row.signature ? "settled" : row.x402_pending_at ? "payment_outcome_unknown" : "awaiting_payment") {
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
  await assertDevnet();
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

async function verifySignature(row, signature, x402 = false) {
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
    return { signature, payer: verifiedPayer(transaction, x402 ? { recipient: row.recipient, memo: row.id } : row) };
  } catch (error) {
    if (error instanceof PaymentMismatch) throw new ApiError(409, "payment_mismatch");
    throw error;
  }
}

async function reconcile(row, submittedSignature) {
  if (row.signature) return receipt(row);
  await assertDevnet();
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
  return receipt(settle(row, payment));
}

async function recoverX402(row, submittedSignature) {
  if (row.signature) return receipt(row);
  if (!row.x402_pending_at) throw new ApiError(409, "x402_recovery_not_pending");
  await assertDevnet();
  let payment;
  if (submittedSignature) {
    payment = await verifySignature(row, submittedSignature, true);
  } else {
    const accounts = await rpc("getTokenAccountsByOwner", [row.recipient, { mint: DEVNET_USDC_MINT }, {
      encoding: "jsonParsed", commitment: "confirmed",
    }]);
    for (const account of accounts?.value ?? []) {
      // ponytail: newest 200 per account; paginate with `before` if the recipient gets busier. POST /recover covers older payments.
      const candidates = await rpc("getSignaturesForAddress", [account.pubkey, { limit: 200, commitment: "confirmed" }]);
      for (const candidate of candidates) {
        if (candidate.err) continue;
        try {
          const found = await verifySignature(row, candidate.signature, true);
          if (found !== "pending_confirmation") {
            payment = found;
            break;
          }
        } catch (error) {
          if (!(error instanceof ApiError && error.code === "payment_mismatch")) throw error;
        }
      }
      if (payment) break;
    }
  }
  if (!payment || payment === "pending_confirmation") return receipt(row);
  return receipt(settle(row, payment));
}

async function x402Receipt(request, row) {
  if (row.signature) return response(receipt(row));
  if (row.x402_pending_at) return response(await recoverX402(row));
  const current = await reconcile(row);
  if (current.status !== "awaiting_payment") return response(current);
  if ((request.headers.get("payment-signature")?.length ?? 0) > 32_768) throw new ApiError(413, "payment_header_too_large");
  try {
    x402Ready ??= x402Server.initialize();
    await x402Ready;
  } catch {
    x402Ready = undefined;
    throw new ApiError(503, "x402_facilitator_unavailable");
  }

  const url = new URL(request.url);
  const adapter = {
    getHeader: (name) => request.headers.get(name) ?? undefined,
    getMethod: () => request.method,
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => request.headers.get("accept") ?? "application/json",
    getUserAgent: () => request.headers.get("user-agent") ?? "",
  };
  const context = { adapter, path: url.pathname, method: request.method };
  const server = new x402HTTPResourceServer(x402Server, {
    [`GET ${url.pathname}`]: {
      accepts: {
        scheme: "exact",
        network: X402_NETWORK,
        payTo: row.recipient,
        price: { amount: String(AMOUNT_BASE_UNITS), asset: DEVNET_USDC_MINT },
        extra: { memo: row.id },
      },
      description: "FlightSweeper confirmed-booking agent service fee (Duffel test, Solana Devnet)",
      mimeType: "application/json",
    },
  });
  const result = await server.processHTTPRequest(context);
  if (result.type === "payment-error") {
    const { status, headers, body } = result.response;
    return new Response(typeof body === "string" ? body : JSON.stringify(body ?? {}), {
      status,
      headers: { ...headers, "Cache-Control": "no-store" },
    });
  }
  if (result.type !== "payment-verified") throw new ApiError(500, "x402_route_unprotected");
  const pending = db.query("UPDATE invoices SET x402_pending_at = ? WHERE id = ? AND signature IS NULL AND x402_pending_at IS NULL").run(
    new Date().toISOString(), row.id,
  );
  if (pending.changes !== 1) return response(receipt(invoice(row.id)));
  let settled;
  try {
    settled = await server.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      { request: context },
      undefined,
      result.beforeHandlerSettlement,
    );
  } catch {
    throw new ApiError(503, "x402_settlement_outcome_unknown");
  }
  if (!settled.success) throw new ApiError(503, "x402_settlement_outcome_unknown");
  if (!settled.transaction) throw new ApiError(503, "x402_settlement_outcome_unknown");
  const verified = await verifySignature(row, settled.transaction, true);
  if (verified === "pending_confirmation") throw new ApiError(503, "x402_settlement_outcome_unknown");
  if (settled.payer && settled.payer !== verified.payer) throw new ApiError(409, "payment_mismatch");
  return Response.json(receipt(settle(row, verified)), {
    headers: { ...settled.headers, "Cache-Control": "no-store" },
  });
}

const assets = {
  "/": ["../web/index.html", "text/html; charset=utf-8"],
  "/style.css": ["../web/style.css", "text/css; charset=utf-8"],
  "/logo-mark.svg": ["../web/logo-mark.svg", "image/svg+xml"],
  "/duffel-logo.svg": ["../web/duffel-logo.svg", "image/svg+xml"],
  "/solana-mark.svg": ["../web/solana-mark.svg", "image/svg+xml"],
  "/hero-bg-generated.avif": ["../web/hero-bg-generated.avif", "image/avif"],
  "/demo.mp4": ["../web/demo.mp4", "video/mp4"],
  "/demo-transcript.txt": ["../web/demo-transcript.txt", "text/plain; charset=utf-8"],
};

export async function handle(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && assets[url.pathname]) {
    const [path, contentType] = assets[url.pathname];
    let file = Bun.file(new URL(path, import.meta.url));
    const size = file.size;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (range && start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    if (range) file = file.slice(start, end + 1);
    return new Response(file, {
      status: range ? 206 : 200,
      headers: {
        "Accept-Ranges": "bytes",
        ...(range && { "Content-Range": `bytes ${start}-${end}/${size}` }),
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (url.pathname === "/health" && request.method === "GET") {
    return response({ status: "ok", environment: "solana_devnet_test" });
  }
  if (!authenticated(request)) throw new ApiError(401, "unauthorized");
  if (url.pathname === "/invoices" && request.method === "POST") return createInvoice(request);
  const match = /^\/invoices\/(fee_[0-9a-f-]+)(?:\/(settle|x402|recover))?$/.exec(url.pathname);
  if (!match) throw new ApiError(404, "not_found");
  const row = invoice(match[1]);
  if (!row) throw new ApiError(404, "not_found");
  if (request.method === "GET" && !match[2]) {
    const current = row.x402_pending_at ? await recoverX402(row) : null;
    return response(current?.status === "settled" ? current : await reconcile(invoice(row.id)));
  }
  if (request.method === "GET" && match[2] === "x402") return x402Receipt(request, row);
  if (request.method === "POST" && match[2] === "recover") {
    const input = await bodyJson(request);
    if (!input || Object.keys(input).join() !== "signature") throw new ApiError(400, "invalid_request");
    return response(await recoverX402(row, input.signature));
  }
  if (request.method === "POST" && match[2] === "settle") {
    const input = await bodyJson(request);
    if (!input || Object.keys(input).join() !== "signature") throw new ApiError(400, "invalid_request");
    return response(await reconcile(row, input.signature));
  }
  throw new ApiError(405, "method_not_allowed");
}

if (import.meta.main) {
  Bun.serve({
    hostname: HOST,
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
  process.stdout.write(`FlightSweeper Solana demo listening on http://${HOST}:${PORT}\n`);
}
