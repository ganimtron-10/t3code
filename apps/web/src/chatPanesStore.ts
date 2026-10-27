import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  activateTab,
  addTab,
  clampPaneRatio,
  collectLeaves,
  equalizePanes,
  findLeafByThread,
  findNode,
  isRestorableLayout,
  leafThreads,
  movePane,
  moveTab,
  removePane,
  removeTab,
  resolveDropZone,
  resolveEdgeDropZone,
  setPaneCollapsed,
  setPaneRatio,
  splitPane,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type DropZone,
} from "./chatPanes.logic";
import { randomUUID } from "./lib/utils";
import { resolveStorage } from "./lib/storage";

/**
 * The window's split layout. The route stays the source of truth for the
 * focused thread; this store only remembers which threads sit beside it, how
 * the space is divided, and which pane last had focus. A layout that shrinks
 * to one pane with one tab is the plain chat view, so it is dropped then.
 */

/** Drop target id for a thread shown on its own, outside any layout. */
export const SOLO_PANE_ID = "solo";

export interface ChatPaneDropTarget {
  readonly paneId: ChatPaneId;
  readonly zone: DropZone;
}

export interface ChatPaneDrag {
  readonly threadRef: ScopedThreadRef;
  /** The pane being moved, or null when the thread comes from outside the layout. */
  readonly sourcePaneId: ChatPaneId | null;
  readonly target: ChatPaneDropTarget | null;
}

interface ChatPanesState {
  root: ChatPaneNode | null;
  /** The pane threads opened from outside the layout join as a tab. */
  focusedPaneId: ChatPaneId | null;
  drag: ChatPaneDrag | null;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
  equalize: () => void;
}

const ThreadRefSchema = Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId });
const NodeSchema: Schema.Codec<ChatPaneNode> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("leaf"),
    id: Schema.String,
    threadRef: ThreadRefSchema,
    tabs: Schema.optionalKey(Schema.Array(ThreadRefSchema)),
    collapsed: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("split"),
    id: Schema.String,
    direction: Schema.Literals(["horizontal", "vertical"]),
    ratio: Schema.Finite,
    first: Schema.suspend(() => NodeSchema),
    second: Schema.suspend(() => NodeSchema),
  }),
]) as Schema.Codec<ChatPaneNode>;
const decodePersisted = Schema.decodeUnknownSync(
  Schema.Struct({
    root: Schema.NullOr(NodeSchema),
    focusedPaneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set) => ({
      root: null,
      focusedPaneId: null,
      drag: null,
      setRatio: (splitId, ratio) =>
        set((state) => {
          if (!state.root) return state;
          const root = setPaneRatio(state.root, splitId, ratio);
          return root === state.root ? state : { root };
        }),
      equalize: () =>
        set((state) => {
          if (!state.root) return state;
          const root = equalizePanes(state.root);
          return root === state.root ? state : { root };
        }),
    }),
    {
      name: "t3code:chat-panes:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ root: state.root, focusedPaneId: state.focusedPaneId }),
      merge: (persisted, current) => {
        try {
          const { root, focusedPaneId = null } = decodePersisted(persisted);
          const restored = normalize(root);
          return {
            ...current,
            root: restored && isRestorableLayout(restored) ? clampRatios(restored) : null,
            focusedPaneId,
          };
        } catch {
          return current;
        }
      },
    },
  ),
);

function clampRatios(node: ChatPaneNode): ChatPaneNode {
  if (node.kind === "leaf") return node;
  return {
    ...node,
    ratio: clampPaneRatio(node.ratio),
    first: clampRatios(node.first),
    second: clampRatios(node.second),
  };
}

function newLeaf(threadRef: ScopedThreadRef): ChatPaneLeaf {
  return { kind: "leaf", id: randomUUID(), threadRef };
}

/** A single pane with a single tab is the plain chat view, not a layout. */
function normalize(root: ChatPaneNode | null): ChatPaneNode | null {
  if (!root) return null;
  return root.kind === "split" || leafThreads(root).length > 1 ? root : null;
}

function sameThread(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return scopedThreadKey(a) === scopedThreadKey(b);
}

export function selectRouteLayout(
  root: ChatPaneNode | null,
  routeThreadRef: ScopedThreadRef | null,
): ChatPaneNode | null {
  return findLeafByThread(root, routeThreadRef) ? root : null;
}

/**
 * Places `threadRef` at `target`. When the route thread is not part of the
 * layout, the drop starts a new layout from it and replaces the saved one.
 * Returns whether the layout changed.
 */
export function placeThread(
  routeThreadRef: ScopedThreadRef,
  threadRef: ScopedThreadRef,
  target: ChatPaneDropTarget,
): boolean {
  const { root } = useChatPanesStore.getState();
  const layout = selectRouteLayout(root, routeThreadRef);
  let next: ChatPaneNode | null;
  if (!layout) {
    if (sameThread(routeThreadRef, threadRef)) return false;
    const anchor = newLeaf(routeThreadRef);
    next =
      target.zone === "tabs"
        ? addTab(anchor, anchor.id, threadRef)
        : splitPane(anchor, anchor.id, target.zone, newLeaf(threadRef), randomUUID());
  } else if (!findNode(layout, target.paneId)) {
    return false;
  } else {
    const existing = findLeafByThread(layout, threadRef);
    if (target.zone === "tabs") {
      next = existing
        ? moveTab(layout, threadRef, target.paneId)
        : addTab(layout, target.paneId, threadRef);
    } else if (existing && leafThreads(existing).length === 1) {
      next = movePane(layout, existing.id, target.paneId, target.zone, randomUUID());
    } else {
      // A tab dragged out of a pane with others leaves them behind.
      const rest = existing ? removeTab(layout, threadRef) : layout;
      const targetId = rest && findNode(rest, target.paneId) ? target.paneId : null;
      if (!rest || !targetId) return false;
      next = splitPane(rest, targetId, target.zone, newLeaf(threadRef), randomUUID());
    }
  }
  if (next === root) return false;
  useChatPanesStore.setState({ root: normalize(next) });
  return true;
}

/** Opens `threadRef` to the right of the route thread's pane, or of the whole solo view. */
export function openThreadInSplit(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (!routeThreadRef) return false;
  const layout = selectRouteLayout(useChatPanesStore.getState().root, routeThreadRef);
  const anchor = findLeafByThread(layout, routeThreadRef);
  return placeThread(routeThreadRef, threadRef, {
    paneId: anchor?.id ?? SOLO_PANE_ID,
    zone: "right",
  });
}

export function canOpenThreadInSplit(
  routeThreadRef: ScopedThreadRef | null,
  threadRef: ScopedThreadRef,
): boolean {
  if (!routeThreadRef || scopedThreadKey(routeThreadRef) === scopedThreadKey(threadRef)) {
    return false;
  }
  return !findLeafByThread(
    selectRouteLayout(useChatPanesStore.getState().root, routeThreadRef),
    threadRef,
  );
}

/**
 * Removes a pane. Returns the thread the route should move to when the
 * closed pane was the route thread, so the caller can navigate.
 */
export function closePane(
  paneId: ChatPaneId,
  routeThreadRef: ScopedThreadRef | null,
): ScopedThreadRef | null {
  const { root } = useChatPanesStore.getState();
  const closing = root ? findNode(root, paneId) : null;
  if (!root || closing?.kind !== "leaf") return null;
  const rest = removePane(root, paneId);
  useChatPanesStore.setState({ root: normalize(rest) });
  const closedRoute =
    routeThreadRef !== null && leafThreads(closing).some((ref) => sameThread(ref, routeThreadRef));
  return closedRoute && rest ? collectLeaves(rest)[0]!.threadRef : null;
}

/**
 * Closes `threadRef`'s tab, and its pane with it when it was the last tab.
 * Returns the thread the route should move to when that tab was the route.
 */
export function closeThreadPane(
  threadRef: ScopedThreadRef,
  routeThreadRef: ScopedThreadRef | null,
): ScopedThreadRef | null {
  const { root } = useChatPanesStore.getState();
  const leaf = findLeafByThread(root, threadRef);
  if (!root || !leaf) return null;
  const rest = removeTab(root, threadRef);
  useChatPanesStore.setState({ root: normalize(rest) });
  if (!rest || routeThreadRef === null || !sameThread(threadRef, routeThreadRef)) return null;
  // The neighbouring tab takes over; a closed pane hands off to the first one left.
  return (
    (findNode(rest, leaf.id) as ChatPaneLeaf | null)?.threadRef ?? collectLeaves(rest)[0]!.threadRef
  );
}

/** Closes the route thread's tab, returning the thread the route should move to. */
export function closeRouteThreadPane(routeThreadRef: ScopedThreadRef): ScopedThreadRef | null {
  return closeThreadPane(routeThreadRef, routeThreadRef);
}

export function isThreadInPane(threadRef: ScopedThreadRef): boolean {
  return findLeafByThread(useChatPanesStore.getState().root, threadRef) !== null;
}

/**
 * Folds a pane to its header or unfolds it. The focused pane hands focus to
 * another open pane before folding, so this returns the thread the route
 * should move to; with no other open pane it stays unfolded.
 */
export function togglePaneCollapsed(
  paneId: ChatPaneId,
  routeThreadRef: ScopedThreadRef | null,
): ScopedThreadRef | null {
  const { root } = useChatPanesStore.getState();
  const leaf = root ? findNode(root, paneId) : null;
  if (!root || leaf?.kind !== "leaf") return null;
  if (leaf.collapsed) {
    useChatPanesStore.setState({ root: setPaneCollapsed(root, paneId, false) });
    return null;
  }
  const focused =
    routeThreadRef !== null && scopedThreadKey(leaf.threadRef) === scopedThreadKey(routeThreadRef);
  const next = focused
    ? collectLeaves(root).find((other) => other.id !== paneId && !other.collapsed)
    : undefined;
  if (focused && !next) return null;
  useChatPanesStore.setState({ root: setPaneCollapsed(root, paneId, true) });
  return next?.threadRef ?? null;
}

/**
 * Brings the route thread forward: its tab becomes active, its pane unfolds
 * and becomes the one new threads join.
 */
export function focusThreadPane(threadRef: ScopedThreadRef) {
  const { root, focusedPaneId } = useChatPanesStore.getState();
  const leaf = findLeafByThread(root, threadRef);
  if (!root || !leaf) return;
  const next = setPaneCollapsed(activateTab(root, threadRef), leaf.id, false);
  if (next !== root || focusedPaneId !== leaf.id) {
    useChatPanesStore.setState({ root: next, focusedPaneId: leaf.id });
  }
}

/** The pane a thread opened from outside the layout would join, or null without a layout. */
export function resolveAttachPane(root: ChatPaneNode | null, focusedPaneId: ChatPaneId | null) {
  if (!root) return null;
  const focused = focusedPaneId ? findNode(root, focusedPaneId) : null;
  return focused?.kind === "leaf" ? focused : collectLeaves(root)[0]!;
}

/** Opens `threadRef` as the active tab of the pane that last had focus. */
export function attachThreadToFocusedPane(threadRef: ScopedThreadRef): boolean {
  const { root, focusedPaneId } = useChatPanesStore.getState();
  const pane = resolveAttachPane(root, focusedPaneId);
  if (!root || !pane || findLeafByThread(root, threadRef)) return false;
  useChatPanesStore.setState({ root: addTab(root, pane.id, threadRef), focusedPaneId: pane.id });
  return true;
}

export function startChatPaneDrag(threadRef: ScopedThreadRef, sourcePaneId: ChatPaneId | null) {
  useChatPanesStore.setState({ drag: { threadRef, sourcePaneId, target: null } });
}

export function endChatPaneDrag() {
  if (useChatPanesStore.getState().drag !== null) useChatPanesStore.setState({ drag: null });
}

/**
 * Resolves the drop target under `point` from the rendered panes: the
 * layout's outer edge band wins, then the pane under the pointer. Reading
 * rects instead of hit-testing keeps embedded browsers and drag ghosts from
 * hiding the pane beneath them.
 */
function resolveChatPaneDropTarget(point: { x: number; y: number }): ChatPaneDropTarget | null {
  const contains = (rect: DOMRect) =>
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  // Pane headers sit on the layout's top edge, so the tab strips are checked first.
  for (const element of document.querySelectorAll<HTMLElement>("[data-chat-pane-tabs]")) {
    const paneId = element.dataset.chatPaneTabs;
    if (paneId && contains(element.getBoundingClientRect())) return { paneId, zone: "tabs" };
  }
  const rootElement = document.querySelector<HTMLElement>("[data-chat-panes-root]");
  if (rootElement) {
    const rect = rootElement.getBoundingClientRect();
    if (!contains(rect)) return null;
    const zone = resolveEdgeDropZone(rect, point.x, point.y);
    const rootId = rootElement.dataset.chatPanesRoot;
    if (zone && rootId) return { paneId: rootId, zone };
  }
  for (const element of document.querySelectorAll<HTMLElement>("[data-chat-pane-drop]")) {
    const rect = element.getBoundingClientRect();
    if (!contains(rect)) continue;
    const zone = resolveDropZone(rect, point.x, point.y);
    const paneId = element.dataset.chatPaneDrop;
    return zone && paneId ? { paneId, zone } : null;
  }
  return null;
}

/** Updates the highlighted target for the drag in progress; null clears it. */
export function hoverChatPaneDrop(point: { x: number; y: number } | null) {
  const { drag, root } = useChatPanesStore.getState();
  if (!drag) return;
  let target = point ? resolveChatPaneDropTarget(point) : null;
  if (target && drag.sourcePaneId === target.paneId) {
    // A pane can split off one of its tabs, but cannot take back its only one.
    const source = root ? findNode(root, target.paneId) : null;
    const tabCount = source?.kind === "leaf" ? leafThreads(source).length : 1;
    if (target.zone === "tabs" || tabCount === 1) target = null;
  }
  if (target?.paneId === drag.target?.paneId && target?.zone === drag.target?.zone) return;
  useChatPanesStore.setState({ drag: { ...drag, target } });
}

/**
 * Applies the drag's current target and ends the drag. Returns the thread
 * the route should focus, or null when nothing changed.
 */
export function commitChatPaneDrop(routeThreadRef: ScopedThreadRef | null): ScopedThreadRef | null {
  const { drag } = useChatPanesStore.getState();
  endChatPaneDrag();
  if (!drag?.target || !routeThreadRef) return null;
  return placeThread(routeThreadRef, drag.threadRef, drag.target) ? drag.threadRef : null;
}
