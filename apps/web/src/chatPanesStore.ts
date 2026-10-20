import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  clampPaneRatio,
  collectLeaves,
  equalizePanes,
  findLeafByThread,
  findNode,
  movePane,
  removePane,
  resolveDropZone,
  resolveEdgeDropZone,
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
 * focused thread; this store only remembers which threads sit beside it and
 * how the space is divided. A layout that collapses to one pane is the plain
 * chat view, so it is dropped as soon as that happens.
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
  drag: ChatPaneDrag | null;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
  equalize: () => void;
}

const NodeSchema: Schema.Codec<ChatPaneNode> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("leaf"),
    id: Schema.String,
    threadRef: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
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
  Schema.Struct({ root: Schema.NullOr(NodeSchema) }),
);

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set) => ({
      root: null,
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
      partialize: (state) => ({ root: state.root }),
      merge: (persisted, current) => {
        try {
          const { root } = decodePersisted(persisted);
          return { ...current, root: root?.kind === "split" ? clampRatios(root) : null };
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

/** A single pane is the plain chat view, not a layout. */
function normalize(root: ChatPaneNode | null): ChatPaneNode | null {
  return root?.kind === "split" ? root : null;
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
    if (scopedThreadKey(routeThreadRef) === scopedThreadKey(threadRef)) return false;
    const anchor = newLeaf(routeThreadRef);
    next = splitPane(anchor, anchor.id, target.zone, newLeaf(threadRef), randomUUID());
  } else if (!findNode(layout, target.paneId)) {
    return false;
  } else {
    const existing = findLeafByThread(layout, threadRef);
    next = existing
      ? movePane(layout, existing.id, target.paneId, target.zone, randomUUID())
      : splitPane(layout, target.paneId, target.zone, newLeaf(threadRef), randomUUID());
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
    routeThreadRef !== null &&
    scopedThreadKey(closing.threadRef) === scopedThreadKey(routeThreadRef);
  return closedRoute && rest ? collectLeaves(rest)[0]!.threadRef : null;
}

/** Closes the pane showing the route thread, returning the pane the route should move to. */
export function closeRouteThreadPane(routeThreadRef: ScopedThreadRef): ScopedThreadRef | null {
  const leaf = findLeafByThread(useChatPanesStore.getState().root, routeThreadRef);
  return leaf ? closePane(leaf.id, routeThreadRef) : null;
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
export function resolveChatPaneDropTarget(point: {
  x: number;
  y: number;
}): ChatPaneDropTarget | null {
  const contains = (rect: DOMRect) =>
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
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
  const { drag } = useChatPanesStore.getState();
  if (!drag) return;
  let target = point ? resolveChatPaneDropTarget(point) : null;
  if (target && drag.sourcePaneId === target.paneId) target = null;
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
