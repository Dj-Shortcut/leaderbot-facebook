import type { MollieAmount } from "./mollieClient";

export function parseAmountMinor(amount: MollieAmount): number {
  if (amount.currency !== "EUR" || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(amount.value)) {
    throw new Error("invalid Mollie amount");
  }
  const [euros, cents] = amount.value.split(".");
  const minor = Number(euros) * 100 + Number(cents);
  if (!Number.isSafeInteger(minor)) {
    throw new Error("Mollie amount is out of range");
  }
  return minor;
}
