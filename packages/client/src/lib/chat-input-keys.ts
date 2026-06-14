/**
 * Keyboard policy for submitting the chat composer. Kept outside the
 * React component so the newline-vs-submit contract has a tiny,
 * DOM-free test: regular Enter belongs to the textarea (newline), and
 * Cmd/Ctrl+Enter is the explicit submit shortcut.
 */
export interface ChatInputKeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export function isChatSubmitShortcut(event: ChatInputKeyLike): boolean {
  return event.key === "Enter" && (event.metaKey === true || event.ctrlKey === true);
}
