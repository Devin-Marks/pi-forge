/**
 * Unit tests for clipboard image extraction used by ChatInput paste handling.
 * Pure helper, no DOM events required — minimal array-like clipboard objects
 * are enough to verify image files become prompt attachments while text items
 * are ignored.
 */
import { extractClipboardImageFiles } from "../packages/client/src/lib/clipboard-images";

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

function arrayLike<T>(values: T[]): { readonly length: number; item(index: number): T | null } {
  return {
    length: values.length,
    item: (index) => values[index] ?? null,
  };
}

function image(name = "pasted.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type, lastModified: 123 });
}

{
  const pasted = image("screenshot.png");
  const got = extractClipboardImageFiles({
    items: arrayLike([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => pasted },
    ]),
  });
  assert("extracts image file items", got.length === 1 && got[0] === pasted);
}

{
  const pasted = image("fallback.webp", "image/webp");
  const got = extractClipboardImageFiles({
    items: arrayLike([{ kind: "string", type: "text/plain", getAsFile: () => null }]),
    files: arrayLike([pasted]),
  });
  assert(
    "falls back to clipboard files when items have no images",
    got.length === 1 && got[0] === pasted,
  );
}

{
  const got = extractClipboardImageFiles({
    items: arrayLike([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      {
        kind: "file",
        type: "application/pdf",
        getAsFile: () => new File(["pdf"], "doc.pdf", { type: "application/pdf" }),
      },
    ]),
  });
  assert("ignores text and non-image clipboard items", got.length === 0);
}

{
  const unnamed = new File([new Uint8Array([4, 5, 6])], "", {
    type: "image/jpeg",
    lastModified: 456,
  });
  const got = extractClipboardImageFiles({ files: arrayLike([unnamed]) });
  assert(
    "names unnamed clipboard images",
    got.length === 1 && got[0]?.name === "clipboard-image-1.jpg",
  );
  assert("preserves unnamed clipboard image type", got[0]?.type === "image/jpeg");
}

if (failures > 0) {
  console.error(`clipboard image tests failed: ${failures}`);
  process.exit(1);
}
console.log("clipboard image tests passed");
