import { createClientId } from "../packages/client/src/lib/client-id";

interface CryptoStub {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");

function setCrypto(value: CryptoStub | undefined): void {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value,
  });
}

try {
  setCrypto({ randomUUID: () => "uuid-from-browser" });
  assert(
    "uses crypto.randomUUID when available",
    createClientId("row") === "row-uuid-from-browser",
  );

  let fill = 0;
  setCrypto({
    getRandomValues: (array: Uint8Array) => {
      array.fill(fill++);
      return array;
    },
  });
  const getRandomValuesId = createClientId("row");
  assert(
    "falls back to getRandomValues when randomUUID is missing",
    getRandomValuesId.startsWith("row-") && getRandomValuesId.length > "row-".length,
    getRandomValuesId,
  );

  setCrypto(undefined);
  const ids = new Set(Array.from({ length: 20 }, () => createClientId("sandbox-env")));
  assert("does not throw without crypto", ids.size === 20, [...ids].join(", "));
  assert(
    "fallback IDs keep the requested prefix",
    [...ids].every((id) => id.startsWith("sandbox-env-")),
    [...ids].join(", "),
  );
} finally {
  if (originalDescriptor === undefined) {
    delete (globalThis as { crypto?: unknown }).crypto;
  } else {
    Object.defineProperty(globalThis, "crypto", originalDescriptor);
  }
}

if (failures > 0) process.exit(1);
