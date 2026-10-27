import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * The split layout is a binary tree whose leaves are placeholders: each holds
 * one or more server threads as tabs and shows the active one.
 * Every function here returns the same node when nothing changed, so a store
 * update that is a no-op keeps every pane memoized.
 */

export type ChatPaneId = string;
export type SplitDirection = "horizontal" | "vertical";
/** An edge splits the pane; "tabs" adds the thread to the pane's tabs. */
export type DropZone = "top" | "bottom" | "left" | "right" | "tabs";
export type SplitZone = Exclude<DropZone, "tabs">;

export interface ChatPaneLeaf {
  readonly kind: "leaf";
  readonly id: ChatPaneId;
  readonly threadRef: ScopedThreadRef;
  /** Every tab in order, including the active one; absent means just `threadRef`. */
  readonly tabs?: readonly ScopedThreadRef[];
  /** Shown as its header only; saved with the layout. */
  readonly collapsed?: boolean;
}

export interface ChatPaneSplit {
  readonly kind: "split";
  readonly id: ChatPaneId;
  readonly direction: SplitDirection;
  readonly first: ChatPaneNode;
  readonly second: ChatPaneNode;
  /** Share of the axis given to `first`. */
  readonly ratio: number;
}

export type ChatPaneNode = ChatPaneLeaf | ChatPaneSplit;

const MIN_PANE_RATIO = 0.15;
const MAX_PANE_RATIO = 0.85;
const EDGE_REGION_FRACTION = 1 / 3;
/** Pointer distance from the layout's outer edge that targets the whole layout. */
const EDGE_DROP_BAND_PX = 24;

export function clampPaneRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

export function collectLeaves(node: ChatPaneNode): ChatPaneLeaf[] {
  return node.kind === "leaf"
    ? [node]
    : [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

export function leafThreads(leaf: ChatPaneLeaf): readonly ScopedThreadRef[] {
  return leaf.tabs ?? [leaf.threadRef];
}

function leafHasThread(leaf: ChatPaneLeaf, key: string): boolean {
  return leafThreads(leaf).some((ref) => scopedThreadKey(ref) === key);
}

export function findNode(node: ChatPaneNode, id: ChatPaneId): ChatPaneNode | null {
  if (node.id === id) return node;
  if (node.kind === "leaf") return null;
  return findNode(node.first, id) ?? findNode(node.second, id);
}

export function findLeafByThread(
  node: ChatPaneNode | null,
  threadRef: ScopedThreadRef | null,
): ChatPaneLeaf | null {
  if (!node || !threadRef) return null;
  const key = scopedThreadKey(threadRef);
  return collectLeaves(node).find((leaf) => leafHasThread(leaf, key)) ?? null;
}

const ZONE_SPLIT: Record<SplitZone, { direction: SplitDirection; side: "first" | "second" }> = {
  left: { direction: "horizontal", side: "first" },
  right: { direction: "horizontal", side: "second" },
  top: { direction: "vertical", side: "first" },
  bottom: { direction: "vertical", side: "second" },
};

/** Wraps node `targetId` (a pane, or the root for the whole layout) in a split with `leaf`. */
export function splitPane(
  root: ChatPaneNode,
  targetId: ChatPaneId,
  zone: SplitZone,
  leaf: ChatPaneLeaf,
  splitId: ChatPaneId,
): ChatPaneNode {
  const { direction, side } = ZONE_SPLIT[zone];
  if (root.id === targetId) {
    return {
      kind: "split",
      id: splitId,
      direction,
      ratio: 0.5,
      first: side === "first" ? leaf : root,
      second: side === "first" ? root : leaf,
    };
  }
  if (root.kind === "leaf") return root;
  const first = splitPane(root.first, targetId, zone, leaf, splitId);
  const second = splitPane(root.second, targetId, zone, leaf, splitId);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

export function setPaneCollapsed(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  collapsed: boolean,
): ChatPaneNode {
  if (root.kind === "leaf") {
    if (root.id !== paneId || (root.collapsed === true) === collapsed) return root;
    if (collapsed) return { ...root, collapsed: true };
    const { collapsed: _collapsed, ...open } = root;
    return open;
  }
  const first = setPaneCollapsed(root.first, paneId, collapsed);
  const second = setPaneCollapsed(root.second, paneId, collapsed);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

/**
 * Whether every pane in `node` is folded. The focused thread's pane always
 * shows, so it never counts as folded even when its saved flag says so.
 */
export function isPaneFolded(node: ChatPaneNode, focusedThreadKey: string): boolean {
  return collectLeaves(node).every(
    (leaf) => leaf.collapsed === true && !leafHasThread(leaf, focusedThreadKey),
  );
}

/** Removes a node. Its sibling takes the parent's slot; removing the root empties the layout. */
export function removePane(root: ChatPaneNode, paneId: ChatPaneId): ChatPaneNode | null {
  if (root.id === paneId) return null;
  if (root.kind === "leaf") return root;
  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);
  if (first === null) return second;
  if (second === null) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

export function setPaneRatio(root: ChatPaneNode, splitId: ChatPaneId, ratio: number): ChatPaneNode {
  if (root.kind === "leaf") return root;
  if (root.id === splitId) {
    const clamped = clampPaneRatio(ratio);
    return clamped === root.ratio ? root : { ...root, ratio: clamped };
  }
  const first = setPaneRatio(root.first, splitId, ratio);
  const second = setPaneRatio(root.second, splitId, ratio);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

/** More threads than this can't be usable, so a saved layout beyond it is tampered or corrupt. */
const MAX_RESTORED_PANES = 32;

/**
 * Whether a decoded layout is safe to render: a bounded number of panes, and
 * no node id or thread used twice. Walks iteratively so a hostile depth can't
 * overflow the stack before it is rejected.
 */
export function isRestorableLayout(root: ChatPaneNode): boolean {
  const ids = new Set<ChatPaneId>();
  const threads = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ids.has(node.id)) return false;
    ids.add(node.id);
    if (node.kind === "split") {
      stack.push(node.first, node.second);
      continue;
    }
    const tabs = leafThreads(node);
    if (!tabs.some((ref) => scopedThreadKey(ref) === scopedThreadKey(node.threadRef))) {
      return false;
    }
    for (const ref of tabs) {
      const key = scopedThreadKey(ref);
      if (threads.has(key) || threads.size >= MAX_RESTORED_PANES) return false;
      threads.add(key);
    }
  }
  return true;
}

/** How many panes sit side by side along `direction`'s axis inside `node`. */
export function paneSpan(node: ChatPaneNode, direction: SplitDirection): number {
  if (node.kind === "leaf") return 1;
  const first = paneSpan(node.first, direction);
  const second = paneSpan(node.second, direction);
  return node.direction === direction ? first + second : Math.max(first, second);
}

/** Sizes every split so the panes along each axis get equal space. */
export function equalizePanes(root: ChatPaneNode): ChatPaneNode {
  if (root.kind === "leaf") return root;
  const firstSpan = paneSpan(root.first, root.direction);
  const ratio = clampPaneRatio(firstSpan / (firstSpan + paneSpan(root.second, root.direction)));
  const first = equalizePanes(root.first);
  const second = equalizePanes(root.second);
  return ratio === root.ratio && first === root.first && second === root.second
    ? root
    : { ...root, ratio, first, second };
}

/** Moves pane `paneId` beside `targetId`. A drop on itself, or on a vanished target, is a no-op. */
export function movePane(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  targetId: ChatPaneId,
  zone: SplitZone,
  splitId: ChatPaneId,
): ChatPaneNode {
  if (paneId === targetId) return root;
  const leaf = findNode(root, paneId);
  if (leaf?.kind !== "leaf") return root;
  const without = removePane(root, paneId);
  if (!without) return root;
  // Pulling the pane out can collapse the root it was dropped on; the edge of
  // the layout is then the survivor's edge.
  const resolvedTargetId = targetId === root.id ? without.id : targetId;
  if (!findNode(without, resolvedTargetId)) return root;
  return splitPane(without, resolvedTargetId, zone, leaf, splitId);
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Which edge of a pane the pointer is closest to, VS Code style: the outer
 * third of the long axis wins outright, the middle falls back to the short axis.
 */
export function resolveDropZone(rect: Rect, clientX: number, clientY: number): SplitZone | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return null;
  const horizontal: SplitZone = relX < 0.5 ? "left" : "right";
  const vertical: SplitZone = relY < 0.5 ? "top" : "bottom";
  const wide = rect.width >= rect.height;
  const longRel = wide ? relX : relY;
  if (longRel < EDGE_REGION_FRACTION || longRel > 1 - EDGE_REGION_FRACTION) {
    return wide ? horizontal : vertical;
  }
  return wide ? vertical : horizontal;
}

/** The outer edge of the whole layout the pointer sits on, so a drop spans it. */
export function resolveEdgeDropZone(
  rect: Rect,
  clientX: number,
  clientY: number,
): SplitZone | null {
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (x < 0 || x > rect.width || y < 0 || y > rect.height) return null;
  if (x < EDGE_DROP_BAND_PX) return "left";
  if (rect.width - x < EDGE_DROP_BAND_PX) return "right";
  if (y < EDGE_DROP_BAND_PX) return "top";
  if (rect.height - y < EDGE_DROP_BAND_PX) return "bottom";
  return null;
}

function mapLeaf(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  update: (leaf: ChatPaneLeaf) => ChatPaneLeaf,
): ChatPaneNode {
  if (root.kind === "leaf") return root.id === paneId ? update(root) : root;
  const first = mapLeaf(root.first, paneId, update);
  const second = mapLeaf(root.second, paneId, update);
  return first === root.first && second === root.second ? root : { ...root, first, second };
}

function withTabs(
  leaf: ChatPaneLeaf,
  tabs: readonly ScopedThreadRef[],
  active: ScopedThreadRef,
): ChatPaneLeaf {
  const { tabs: _tabs, ...rest } = leaf;
  return tabs.length > 1 ? { ...rest, threadRef: active, tabs } : { ...rest, threadRef: active };
}

/** Adds `threadRef` as the active tab of pane `paneId`, right after the current one. */
export function addTab(
  root: ChatPaneNode,
  paneId: ChatPaneId,
  threadRef: ScopedThreadRef,
): ChatPaneNode {
  const key = scopedThreadKey(threadRef);
  return mapLeaf(root, paneId, (leaf) => {
    if (leafHasThread(leaf, key)) return withTabs(leaf, leafThreads(leaf), threadRef);
    const tabs = [...leafThreads(leaf)];
    const at = tabs.findIndex((ref) => scopedThreadKey(ref) === scopedThreadKey(leaf.threadRef));
    tabs.splice(at + 1, 0, threadRef);
    return withTabs(leaf, tabs, threadRef);
  });
}

export function activateTab(root: ChatPaneNode, threadRef: ScopedThreadRef): ChatPaneNode {
  const key = scopedThreadKey(threadRef);
  const leaf = findLeafByThread(root, threadRef);
  if (!leaf || scopedThreadKey(leaf.threadRef) === key) return root;
  const tab = leafThreads(leaf).find((ref) => scopedThreadKey(ref) === key)!;
  return mapLeaf(root, leaf.id, (current) => withTabs(current, leafThreads(current), tab));
}

/**
 * Removes `threadRef`'s tab. The tab beside it becomes active, and a pane left
 * without tabs is removed, its sibling taking its slot.
 */
export function removeTab(root: ChatPaneNode, threadRef: ScopedThreadRef): ChatPaneNode | null {
  const key = scopedThreadKey(threadRef);
  const leaf = findLeafByThread(root, threadRef);
  if (!leaf) return root;
  const tabs = leafThreads(leaf);
  if (tabs.length === 1) return removePane(root, leaf.id);
  const index = tabs.findIndex((ref) => scopedThreadKey(ref) === key);
  const rest = tabs.filter((_, i) => i !== index);
  const active =
    scopedThreadKey(leaf.threadRef) === key
      ? rest[Math.min(index, rest.length - 1)]!
      : leaf.threadRef;
  return mapLeaf(root, leaf.id, (current) => withTabs(current, rest, active));
}

export function moveTab(
  root: ChatPaneNode,
  threadRef: ScopedThreadRef,
  toId: ChatPaneId,
): ChatPaneNode {
  const from = findLeafByThread(root, threadRef);
  if (!from || from.id === toId || findNode(root, toId)?.kind !== "leaf") return root;
  const without = removeTab(root, threadRef);
  if (!without || !findNode(without, toId)) return root;
  return addTab(without, toId, threadRef);
}
