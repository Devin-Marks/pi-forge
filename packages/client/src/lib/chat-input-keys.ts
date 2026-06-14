/**
 * Keyboard policy for submitting the chat composer. Kept outside the
 * React component so the newline-vs-submit contract has a tiny,
 * DOM-free test: desktop Enter submits, Shift+Enter inserts a newline,
 * and Cmd/Ctrl+Enter is an explicit submit shortcut everywhere.
 */
export interface ChatInputKeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export function isChatSubmitShortcut(
  event: ChatInputKeyLike,
  opts: { isMobile: boolean },
): boolean {
  if (event.key !== "Enter") return false;
  if (event.metaKey === true || event.ctrlKey === true) return true;
  return !opts.isMobile && event.shiftKey !== true;
}
