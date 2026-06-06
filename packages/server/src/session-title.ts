const GENERIC_SESSION_NAME_RE = /^New session(?: \(\d+\))?$/;
const MAX_TITLE_LENGTH = 60;
const MAX_TITLE_WORDS = 8;

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "could",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "of",
  "on",
  "please",
  "the",
  "this",
  "to",
  "with",
  "would",
  "you",
]);

export function isGenericSessionName(name: string | undefined): boolean {
  return name === undefined || GENERIC_SESSION_NAME_RE.test(name);
}

export function generateSessionTitleFromPrompt(prompt: string): string | undefined {
  const cleaned = normalizePromptForTitle(prompt);
  if (cleaned.length === 0) return undefined;

  const words = cleaned
    .split(/\s+/)
    .map((word) => cleanWord(word))
    .filter((word) => word.length > 0);
  if (words.length === 0) return undefined;

  const selected = words.slice(0, MAX_TITLE_WORDS);
  const significant = selected.filter((word) => !STOP_WORDS.has(word.toLowerCase()));
  const titleWords = significant.length >= 2 ? significant : selected;
  const title = toTitleCase(titleWords.join(" "));
  return truncateTitle(title);
}

function normalizePromptForTitle(prompt: string): string {
  return prompt
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*\/[\w:-]+\s*/u, "")
    .replace(/@([^\s]+)/g, (_match, path: string) => ` ${basenameLike(path)} `)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/[_*#[\]()>~|{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function basenameLike(path: string): string {
  const trimmed = path.replace(/[.,;:!?]+$/g, "");
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? trimmed;
}

function cleanWord(word: string): string {
  return word
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}+.:-]+$/u, "")
    .trim();
}

function toTitleCase(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => {
      if (/^[A-Z0-9._+-]{2,}$/.test(word)) return word;
      if (/^[\p{L}][\p{L}'’-]*$/u.test(word)) {
        return word.charAt(0).toLocaleUpperCase() + word.slice(1);
      }
      return word;
    })
    .join(" ");
}

function truncateTitle(title: string): string {
  if (title.length <= MAX_TITLE_LENGTH) return title;
  const cut = title.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= 24) return `${cut.slice(0, lastSpace)}…`;
  return `${cut.trimEnd()}…`;
}
