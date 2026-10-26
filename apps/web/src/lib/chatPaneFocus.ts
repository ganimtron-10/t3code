/**
 * Whether `node` renders inside a split pane that does not own window input.
 * Window and document listeners use it so only the focused pane reacts to a
 * keystroke that every mounted pane would otherwise receive.
 */
export function isInBackgroundChatPane(node: Element | null | undefined): boolean {
  return node?.closest('[data-chat-pane-focused="false"]') != null;
}
