import { expect, test } from "bun:test";
import {
  DEVNET_USDC_MINT,
  isPublicKey,
  newReference,
  PaymentMismatch,
  paymentUrl,
  verifiedPayer,
} from "./payment.mjs";

const recipient = "8X39qt9Di4MtoAc1E2qV5tAtvWrbgAek1G7dHBYHcGBq";
const payer = "7ZPJhZfjtNxZBVgP7YAFhBPpQ8QCkaQ9HDVNTM5FXXQv";
const reference = "5caW14tj2JnzEi2Qa7EZwRLF3XFjYEjRpTFRD3wbgB6t";
const balance = (accountIndex, owner, amount, mint = DEVNET_USDC_MINT) => ({
  accountIndex,
  owner,
  mint,
  uiTokenAmount: { amount: String(amount), decimals: 6 },
});
const transaction = () => ({
  meta: {
    err: null,
    preTokenBalances: [balance(1, recipient, 10_000), balance(2, payer, 19_990_000)],
    postTokenBalances: [balance(1, recipient, 20_000), balance(2, payer, 19_980_000)],
  },
  transaction: { message: { accountKeys: [{ pubkey: reference, signer: false, writable: false }] } },
});

test("reference is a public key in a Devnet USDC Solana Pay URL", () => {
  const fresh = newReference();
  expect(isPublicKey(fresh)).toBe(true);
  expect(paymentUrl(recipient, fresh)).toContain(`reference=${fresh}`);
  expect(paymentUrl(recipient, fresh)).toContain(`spl-token=${DEVNET_USDC_MINT}`);
});

test("receipt requires exact recipient increase and identifies payer", () => {
  expect(verifiedPayer(transaction(), { recipient, reference })).toBe(payer);
  const wrongAmount = transaction();
  wrongAmount.meta.postTokenBalances[0].uiTokenAmount.amount = "20001";
  expect(() => verifiedPayer(wrongAmount, { recipient, reference })).toThrow(PaymentMismatch);
});

test("wrong reference and mint cannot settle an invoice", () => {
  const wrongReference = transaction();
  wrongReference.transaction.message.accountKeys = [];
  expect(() => verifiedPayer(wrongReference, { recipient, reference })).toThrow(PaymentMismatch);
  const wrongMint = transaction();
  wrongMint.meta.postTokenBalances[0].mint = "wrong";
  expect(() => verifiedPayer(wrongMint, { recipient, reference })).toThrow(PaymentMismatch);
});
