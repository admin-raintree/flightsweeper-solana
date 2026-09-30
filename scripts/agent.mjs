const [orderId, idempotencyKey] = process.argv.slice(2);
const token = process.env.AGENT_API_TOKEN;
const base = process.env.API_BASE ?? "http://127.0.0.1:8787";
if (!orderId || !idempotencyKey || !token) {
  throw new Error("Set AGENT_API_TOKEN and run: bun scripts/agent.mjs <Duffel test order ID> <UUID>");
}

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const create = async () => {
  const result = await fetch(`${base}/invoices`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orderId, idempotencyKey }),
  });
  const body = await result.json();
  if (!result.ok) throw new Error(`Invoice request: HTTP ${result.status} ${body.error}`);
  return body;
};

let invoice = await create();
process.stdout.write(`${JSON.stringify(invoice, null, 2)}\n`);
if (process.argv.includes("--x402")) {
  const result = await fetch(`${base}/invoices/${invoice.invoiceId}/x402`, { headers });
  if (result.status === 402) {
    const challenge = result.headers.get("PAYMENT-REQUIRED");
    if (!challenge) throw new Error("x402 response is missing PAYMENT-REQUIRED");
    process.stdout.write(`x402 V2 payment requirements:\n${JSON.stringify(JSON.parse(Buffer.from(challenge, "base64").toString("utf8")), null, 2)}\n`);
  } else if (!result.ok) {
    throw new Error(`x402 request: HTTP ${result.status} ${(await result.json()).error}`);
  } else {
    invoice = await result.json();
    process.stdout.write(`x402 route returned a ${invoice.status} receipt:\n${JSON.stringify(invoice, null, 2)}\n`);
  }
}
if (invoice.status !== "settled" && process.argv.includes("--watch")) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await Bun.sleep(2_000);
    const result = await fetch(`${base}/invoices/${invoice.invoiceId}`, { headers });
    invoice = await result.json();
    if (!result.ok) throw new Error(`Receipt read: HTTP ${result.status} ${invoice.error}`);
    if (invoice.status === "settled") break;
  }
  process.stdout.write(`${JSON.stringify(invoice, null, 2)}\n`);
}

if (invoice.status === "settled") {
  const retry = await create();
  if (retry.invoiceId !== invoice.invoiceId || retry.transactionSignature !== invoice.transactionSignature || retry.paymentUrl !== null) {
    throw new Error("Idempotent retry did not return the same settled receipt");
  }
  process.stdout.write("Retry verified: same invoice and transaction; no second payment URL.\n");
}
