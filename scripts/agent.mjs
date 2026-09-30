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
