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
  const instructions = transaction?.transaction?.message?.instructions;
  const before = transaction?.meta?.preTokenBalances;
  const after = transaction?.meta?.postTokenBalances;
  if (
    transaction?.meta?.err !== null ||
    !Array.isArray(keys) ||
    !Array.isArray(instructions) ||
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
  const recipients = after.filter((entry) => entry.mint === DEVNET_USDC_MINT && entry.owner === recipient);
  if (recipients.length !== 1) throw new PaymentMismatch("Recipient token account is ambiguous");
  const destination = recipients[0];
  const previous = before.find((entry) => entry.accountIndex === destination.accountIndex);
  if (previous?.mint !== DEVNET_USDC_MINT || previous.owner !== recipient ||
    balance(destination) - balance(previous) !== AMOUNT_BASE_UNITS) {
    throw new PaymentMismatch("Received amount differs");
  }

  const destinationAddress = keys[destination.accountIndex]?.pubkey;
  const transfers = instructions.filter((instruction) => {
    const info = instruction.parsed?.info;
    return instruction.program === "spl-token" &&
      ["transfer", "transferChecked"].includes(instruction.parsed?.type) &&
      info?.destination === destinationAddress &&
      (info.mint === undefined || info.mint === DEVNET_USDC_MINT) &&
      (info.tokenAmount?.amount ?? info.amount) === String(AMOUNT_BASE_UNITS);
  });
  if (transfers.length !== 1) throw new PaymentMismatch("Transfer instruction differs");
  const sourceAddress = transfers[0].parsed.info.source;
  const sourceIndex = keys.findIndex((key) => key.pubkey === sourceAddress);
  const sourceBefore = before.find((entry) => entry.accountIndex === sourceIndex);
  const sourceAfter = after.find((entry) => entry.accountIndex === sourceIndex);
  if (sourceBefore?.mint !== DEVNET_USDC_MINT || sourceAfter?.mint !== DEVNET_USDC_MINT ||
    !sourceBefore.owner || sourceBefore.owner === recipient ||
    sourceBefore.owner !== sourceAfter.owner ||
    balance(sourceBefore) - balance(sourceAfter) < AMOUNT_BASE_UNITS) {
    throw new PaymentMismatch("Transfer payer differs");
  }
  return sourceBefore.owner;
}
