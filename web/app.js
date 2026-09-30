const tokenInput = document.querySelector("#api-token");
const orderInput = document.querySelector("#order-id");
const keyInput = document.querySelector("#idempotency-key");
const message = document.querySelector("#console-message");
const output = document.querySelector("#api-output");
const refreshButton = document.querySelector("#refresh-button");
const paymentAction = document.querySelector("#payment-action");
const paymentLink = document.querySelector("#payment-link");
const settleForm = document.querySelector("#settle-form");
let invoiceId;

keyInput.value = crypto.randomUUID();

function showReceipt(receipt) {
  output.textContent = JSON.stringify(receipt, null, 2);
  invoiceId = receipt.invoiceId;
  refreshButton.disabled = !invoiceId;
  settleForm.hidden = !invoiceId || receipt.status === "settled";
  const url = receipt.paymentUrl;
  paymentAction.hidden = !(typeof url === "string" && url.startsWith("solana:"));
  if (!paymentAction.hidden) paymentLink.href = url;
  message.textContent = receipt.status === "settled"
    ? "Settled. Retry with the same key to get this receipt again."
    : receipt.status === "pending_confirmation"
      ? "Confirmation is pending. Check this receipt again; do not send another transfer."
      : "Invoice ready. Keep this key and check the receipt after payment.";
}

async function request(path, options = {}) {
  const token = tokenInput.value.trim();
  if (!token) throw new Error("Enter the agent API token.");
  const response = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await response.json();
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
  paymentAction.hidden = true;
  settleForm.hidden = true;
  output.textContent = '{\n  "status": "checking_order"\n}';
  run(() => request("/invoices", {
    method: "POST",
    body: JSON.stringify({ orderId: orderInput.value.trim(), idempotencyKey: keyInput.value.trim() }),
  }));
});

refreshButton.addEventListener("click", () => run(() => request(`/invoices/${invoiceId}`)));

settleForm.addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => request(`/invoices/${invoiceId}/settle`, {
    method: "POST",
    body: JSON.stringify({ signature: document.querySelector("#signature").value.trim() }),
  }));
});
