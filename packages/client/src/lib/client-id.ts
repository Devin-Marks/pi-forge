let fallbackCounter = 0;

function fallbackRandomPart(): string {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject !== undefined && typeof cryptoObject.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function createClientId(prefix: string): string {
  const cryptoObject = globalThis.crypto;
  const id =
    cryptoObject !== undefined && typeof cryptoObject.randomUUID === "function"
      ? cryptoObject.randomUUID()
      : fallbackRandomPart();
  return `${prefix}-${id}`;
}
