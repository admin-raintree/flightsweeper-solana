import { randomBytes } from "node:crypto";

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const AMOUNT_BASE_UNITS = 10_000n;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export class PaymentMismatch extends Error {}

export function isPublicKey(value) {
  if (typeof value !== "string" || !value || value.length > 44) return false;
  let number = 0n;
  for (const character of value) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) return false;
    number = number * 58n + BigInt(digit);
  }
  let bytes = 0;
  while (number > 0n) {
    bytes++;
    number >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}

export function newReference() {
  const bytes = randomBytes(32);
  let number = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (number > 0n) {
    encoded = ALPHABET[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

export function paymentUrl(recipient, reference) {
  const params = new URLSearchParams({
    amount: "0.01",
    "spl-token": DEVNET_USDC_MINT,
    reference,
  });
  return `solana:${recipient}?${params}`;
}

export function verifiedPayer(transaction, { recipient, reference }) {
  const keys = transaction?.transaction?.message?.accountKeys;
  const before = transaction?.meta?.preTokenBalances;
  const after = transaction?.meta?.postTokenBalances;
  if (
    transaction?.meta?.err !== null ||
    !Array.isArray(keys) ||
    !keys.some((key) => key.pubkey === reference && key.signer === false && key.writable === false) ||
    !Array.isArray(before) ||
    !Array.isArray(after)
  ) {
    throw new PaymentMismatch("Transaction or reference does not match");
  }

  const balance = (entry) => {
    if (entry?.uiTokenAmount?.decimals !== 6) throw new PaymentMismatch("Token decimals differ");
    try {
      return BigInt(entry.uiTokenAmount.amount);
    } catch {
      throw new PaymentMismatch("Token amount is invalid");
    }
  };
  const matching = after.filter((entry) => entry.mint === DEVNET_USDC_MINT && entry.owner === recipient);
  const received = matching.reduce((sum, entry) => {
    const previous = before.find((item) => item.accountIndex === entry.accountIndex);
    if (previous?.mint !== DEVNET_USDC_MINT || previous.owner !== recipient) {
      throw new PaymentMismatch("Recipient token account differs");
    }
    return sum + balance(entry) - balance(previous);
  }, 0n);
  if (received !== AMOUNT_BASE_UNITS) throw new PaymentMismatch("Received amount differs");

  const payers = before.filter((entry) => {
    if (entry.mint !== DEVNET_USDC_MINT || !entry.owner || entry.owner === recipient) return false;
    const next = after.find((item) => item.accountIndex === entry.accountIndex);
    return next?.mint === DEVNET_USDC_MINT && balance(entry) - balance(next) >= AMOUNT_BASE_UNITS;
  });
  if (payers.length !== 1) throw new PaymentMismatch("Payer is ambiguous");
  return payers[0].owner;
}
