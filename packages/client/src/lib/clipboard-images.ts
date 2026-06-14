/**
 * Helpers for turning clipboard image payloads into File attachments.
 * Kept DOM-light and pure enough to unit-test without a browser: tests can
 * provide minimal item/file array-like objects instead of real DataTransfer.
 */

interface ClipboardFileLike {
  readonly name?: string;
  readonly type: string;
}

interface ClipboardItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile(): File | null;
}

interface ClipboardListLike<T> {
  readonly length: number;
  item?(index: number): T | null;
  [index: number]: T | undefined;
}

export interface ClipboardImageDataLike {
  readonly items?: ClipboardListLike<ClipboardItemLike>;
  readonly files?: ClipboardListLike<File>;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function listEntry<T>(list: ClipboardListLike<T>, index: number): T | undefined {
  return list.item?.(index) ?? list[index];
}

function isImageFile(file: ClipboardFileLike | null | undefined): file is File {
  return file instanceof File && file.type.startsWith("image/");
}

function clipboardImageName(file: File, index: number): string {
  if (file.name.trim().length > 0) return file.name;
  const extension = IMAGE_EXTENSIONS[file.type.toLowerCase()] ?? "png";
  return `clipboard-image-${index + 1}.${extension}`;
}

function normalizeClipboardImage(file: File, index: number): File {
  const name = clipboardImageName(file, index);
  if (name === file.name) return file;
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

/**
 * Extract image files from clipboard data.
 *
 * Prefer DataTransferItemList because it reliably exposes typed clipboard
 * image payloads in Chromium/Firefox. Fall back to DataTransfer.files for
 * browsers that only expose pasted images there. Text/HTML items are ignored.
 */
export function extractClipboardImageFiles(data: ClipboardImageDataLike): File[] {
  const fromItems: File[] = [];
  const items = data.items;
  if (items !== undefined) {
    for (let i = 0; i < items.length; i++) {
      const item = listEntry(items, i);
      if (item === undefined) continue;
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (isImageFile(file)) fromItems.push(normalizeClipboardImage(file, fromItems.length));
    }
  }
  if (fromItems.length > 0) return fromItems;

  const fromFiles: File[] = [];
  const files = data.files;
  if (files === undefined) return fromFiles;
  for (let i = 0; i < files.length; i++) {
    const file = listEntry(files, i);
    if (isImageFile(file)) fromFiles.push(normalizeClipboardImage(file, fromFiles.length));
  }
  return fromFiles;
}
