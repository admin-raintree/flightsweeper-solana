const tokenInput = document.querySelector("#api-token");
const orderInput = document.querySelector("#order-id");
const keyInput = document.querySelector("#idempotency-key");
const message = document.querySelector("#console-message");
const output = document.querySelector("#api-output");
const refreshButton = document.querySelector("#refresh-button");
const x402Button = document.querySelector("#x402-button");
const paymentAction = document.querySelector("#payment-action");
const paymentLink = document.querySelector("#payment-link");
const settleForm = document.querySelector("#settle-form");
let invoiceId;
let invoiceStatus;

keyInput.value = crypto.randomUUID();

function showReceipt(receipt) {
  output.textContent = JSON.stringify(receipt, null, 2);
  invoiceId = receipt.invoiceId;
  invoiceStatus = receipt.status;
  refreshButton.disabled = !invoiceId;
  x402Button.disabled = !invoiceId;
  settleForm.hidden = !invoiceId || receipt.status === "settled";
  const url = receipt.paymentUrl;
  paymentAction.hidden = !(typeof url === "string" && url.startsWith("solana:"));
  if (!paymentAction.hidden) paymentLink.href = url;
  if (receipt.status === "settled") message.textContent = "Settled. Retry with the same key to get this receipt again.";
  else if (receipt.status === "pending_confirmation") message.textContent = "Confirmation is pending. Check this receipt again; do not send another transfer.";
  else if (receipt.status === "payment_outcome_unknown") message.textContent = "Payment outcome is unknown. Check the receipt or submit the original signature; do not pay again.";
  else message.textContent = "Invoice ready. Keep this key and check the receipt after payment.";
}

async function request(path, options = {}) {
  const token = tokenInput.value.trim();
  if (!token) throw new Error("Enter the agent API token.");
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.error ?? "request_failed"}`);
  return body;
}

async function run(action) {
  message.textContent = "Checking…";
  try {
    showReceipt(await action());
  } catch (error) {
    message.textContent = error.message;
  }
}

document.querySelector("#invoice-form").addEventListener("submit", (event) => {
  event.preventDefault();
  invoiceId = undefined;
  refreshButton.disabled = true;
  x402Button.disabled = true;
  paymentAction.hidden = true;
  settleForm.hidden = true;
  output.textContent = '{\n  "status": "checking_order"\n}';
  run(() => request("/invoices", {
    method: "POST",
    body: JSON.stringify({ orderId: orderInput.value.trim(), idempotencyKey: keyInput.value.trim() }),
  }));
});

refreshButton.addEventListener("click", () => run(() => request(`/invoices/${invoiceId}`)));

x402Button.addEventListener("click", async () => {
  message.textContent = "Checking x402 terms…";
  try {
    const token = tokenInput.value.trim();
    if (!token) throw new Error("Enter the agent API token.");
    const result = await fetch(`/invoices/${invoiceId}/x402`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (result.ok) return showReceipt(await result.json());
    if (result.status !== 402) throw new Error(`HTTP ${result.status}: x402 request failed`);
    const header = result.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new Error("x402 payment terms are unavailable.");
    output.textContent = JSON.stringify(JSON.parse(atob(header)), null, 2);
    message.textContent = "x402 V2 terms are ready. An agent wallet signs the payment and retries this URL with PAYMENT-SIGNATURE.";
  } catch (error) {
    message.textContent = error.message;
  }
});

settleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => request(`/invoices/${invoiceId}/${invoiceStatus === "payment_outcome_unknown" ? "recover" : "settle"}`, {
    method: "POST",
    body: JSON.stringify({ signature: document.querySelector("#signature").value.trim() }),
  }));
});
