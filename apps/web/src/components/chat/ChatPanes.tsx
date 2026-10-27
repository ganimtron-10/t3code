import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GripVerticalIcon, PlusIcon, XIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  clampPaneRatio,
  isPaneFolded,
  setPaneCollapsed,
  leafThreads,
  paneSpan,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type DropZone,
  type SplitDirection,
} from "~/chatPanes.logic";
import {
  closePane,
  closeThreadPane,
  commitChatPaneDrop,
  endChatPaneDrag,
  focusThreadPane,
  hoverChatPaneDrop,
  startChatPaneDrag,
  togglePaneCollapsed,
  useChatPanesStore,
} from "~/chatPanesStore";
import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { buildThreadRouteParams } from "~/threadRoutes";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ZONE_CLASS: Record<DropZone, string> = {
  top: "inset-x-0 top-0 h-1/2",
  bottom: "inset-x-0 bottom-0 h-1/2",
  left: "inset-y-0 left-0 w-1/2",
  right: "inset-y-0 right-0 w-1/2",
  tabs: "inset-0",
};

const EDGE_ZONE_CLASS: Record<DropZone, string> = {
  top: "inset-x-0 top-0 h-1/3",
  bottom: "inset-x-0 bottom-0 h-1/3",
  left: "inset-y-0 left-0 w-1/3",
  right: "inset-y-0 right-0 w-1/3",
  tabs: "inset-0",
};

/** Paints the region a drop on `paneId` would hand to the carried thread. */
function DropHighlight({ paneId, edge = false }: { paneId: ChatPaneId; edge?: boolean }) {
  const zone = useChatPanesStore((state) =>
    state.drag?.target?.paneId === paneId ? state.drag.target.zone : null,
  );
  if (!zone) return null;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-50 m-1.5 rounded-xl border border-primary/50 bg-primary/12",
        (edge ? EDGE_ZONE_CLASS : ZONE_CLASS)[zone],
      )}
    />
  );
}

/**
 * Marks a thread shown on its own as a drop target, so a drop starts a layout.
 * Drafts and narrow windows render it disabled rather than not at all: the
 * same parent element keeps ChatView mounted across a draft's promotion.
 */
export function ChatPaneDropArea({
  paneId,
  enabled,
  children,
}: {
  paneId: ChatPaneId;
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-chat-pane-drop={enabled ? paneId : undefined}
    >
      {children}
      {enabled ? <DropHighlight paneId={paneId} /> : null}
    </div>
  );
}

function useFollowThread() {
  const navigate = useNavigate();
  return useStableCallback((threadRef: ScopedThreadRef | null, replace?: boolean) => {
    if (!threadRef) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: replace === true,
    });
  });
}

/**
 * Renders the split layout. Every leaf mounts its own ChatView keyed by pane,
 * so focusing another pane only changes the route, never remounts a view. The
 * route thread's pane owns window-level input; the others still stream.
 */
export function ChatPanes({
  root,
  routeThreadRef,
  draft,
}: {
  root: ChatPaneNode;
  routeThreadRef: ScopedThreadRef;
  /** A new thread being written, shown as the active tab of pane `paneId`. */
  draft?: PaneDraft | undefined;
}) {
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  const shown = draft ? setPaneCollapsed(root, draft.paneId, false) : root;
  // The focused thread's tab comes forward and a folded pane opens back up.
  // Keyed on the thread, not the ref object, so folding the focused pane
  // isn't undone by a render that lands before the route moves on.
  // oxlint-disable-next-line t3code/react-effect-budget -- syncs the persisted layout to the route
  useEffect(() => {
    const ref = parseScopedThreadKey(routeThreadKey);
    if (ref) focusThreadPane(ref);
  }, [routeThreadKey]);
  return (
    <div
      // Panes keep a readable minimum size; past that the layout scrolls instead of crushing them.
      className="relative flex min-h-0 min-w-0 flex-1 overflow-auto bg-background"
      data-chat-panes-root={root.id}
    >
      <div className="flex flex-1" style={minSize(shown, routeThreadKey)}>
        <PaneNode
          node={shown}
          edges={WINDOW_TOP_EDGES}
          routeThreadKey={routeThreadKey}
          routeThreadRef={routeThreadRef}
          draft={draft}
        />
      </div>
      <DropHighlight paneId={root.id} edge />
    </div>
  );
}

/** Which window edges a node touches, for the title bar insets only the corner panes need. */
interface PaneEdges {
  readonly top: boolean;
  readonly left: boolean;
  readonly right: boolean;
}

const WINDOW_TOP_EDGES: PaneEdges = { top: true, left: true, right: true };

export interface PaneDraft {
  readonly paneId: ChatPaneId;
  readonly view: ReactNode;
}

/** How a folded pane draws its header: a bar across a column, or a strip down a row. */
type PaneFold = "bar" | "strip";

interface PaneNodeProps {
  node: ChatPaneNode;
  edges: PaneEdges;
  routeThreadKey: string;
  routeThreadRef: ScopedThreadRef;
  /** Set inside a run of folded panes, which share the space their headers need. */
  fold?: PaneFold | undefined;
  draft: PaneDraft | undefined;
}

function PaneNode({ node, edges, routeThreadKey, routeThreadRef, fold, draft }: PaneNodeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (node.kind === "leaf") {
    const draftView = draft?.paneId === node.id ? draft.view : undefined;
    return (
      <PaneLeaf
        leaf={node}
        edges={edges}
        focused={draftView !== undefined || scopedThreadKey(node.threadRef) === routeThreadKey}
        routeThreadRef={routeThreadRef}
        fold={draftView === undefined ? fold : undefined}
        draftView={draftView}
      />
    );
  }
  const horizontal = node.direction === "horizontal";
  const splitId = node.id;
  const firstEdges = horizontal ? { ...edges, right: false } : edges;
  const secondEdges = horizontal ? { ...edges, left: false } : { ...edges, top: false };
  const sideFold = (side: ChatPaneNode): PaneFold | undefined =>
    fold ?? (isPaneFolded(side, routeThreadKey) ? (horizontal ? "strip" : "bar") : undefined);
  const firstFold = sideFold(node.first);
  const secondFold = sideFold(node.second);
  const resizable = !firstFold && !secondFold;
  // A folded side shrinks to its headers and the open side takes the rest.
  const sideStyle = (side: ChatPaneNode, sideFolded: boolean): CSSProperties | undefined => {
    if (fold) return undefined;
    if (sideFolded) return { flex: `0 0 ${foldedExtent(side, node.direction)}px` };
    return minSize(side, routeThreadKey);
  };
  return (
    <div
      ref={containerRef}
      className={cn("flex min-h-0 min-w-0 flex-1", horizontal ? "flex-row" : "flex-col")}
      style={{ "--pane-ratio": node.ratio } as CSSProperties}
    >
      <div
        className={cn(
          "flex flex-col",
          resizable ? "flex-[var(--pane-ratio)_1_0px]" : "min-h-0 min-w-0 flex-[1_1_0px]",
        )}
        style={sideStyle(node.first, firstFold !== undefined)}
      >
        <PaneNode
          key={node.first.id}
          node={node.first}
          edges={firstEdges}
          routeThreadKey={routeThreadKey}
          routeThreadRef={routeThreadRef}
          fold={firstFold}
          draft={draft}
        />
      </div>
      {resizable ? (
        <ResizeHandle
          direction={node.direction}
          ratio={node.ratio}
          containerRef={containerRef}
          onCommit={(ratio) => useChatPanesStore.getState().setRatio(splitId, ratio)}
        />
      ) : (
        <div aria-hidden className={cn("shrink-0 bg-border", horizontal ? "w-px" : "h-px")} />
      )}
      <div
        className={cn(
          "flex flex-col",
          resizable ? "flex-[calc(1-var(--pane-ratio))_1_0px]" : "min-h-0 min-w-0 flex-[1_1_0px]",
        )}
        style={sideStyle(node.second, secondFold !== undefined)}
      >
        <PaneNode
          key={node.second.id}
          node={node.second}
          edges={secondEdges}
          routeThreadKey={routeThreadKey}
          routeThreadRef={routeThreadRef}
          fold={secondFold}
          draft={draft}
        />
      </div>
    </div>
  );
}

/** Capture is best effort: it throws for a pointer the browser no longer tracks. */
function capturePointer(element: Element, pointerId: number) {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Moves still arrive while the pointer stays over the element.
  }
}

const MIN_PANE_WIDTH_PX = 320;
const MIN_PANE_HEIGHT_PX = 240;
/** A folded pane's header, `h-7` across or `w-7` down. */
const FOLDED_PANE_PX = 28;

/** Room a run of folded panes needs along `direction`: their headers and the dividers between. */
function foldedExtent(node: ChatPaneNode, direction: SplitDirection): number {
  const span = paneSpan(node, direction);
  return span * FOLDED_PANE_PX + span - 1;
}

/**
 * Explicit minimums rather than `min-width: auto`, which would size a pane
 * to its whole timeline instead of letting the timeline scroll inside it.
 */
function minSize(
  node: ChatPaneNode,
  routeThreadKey: string,
): { minWidth: number; minHeight: number } {
  if (node.kind === "leaf") return { minWidth: MIN_PANE_WIDTH_PX, minHeight: MIN_PANE_HEIGHT_PX };
  const sideMin = (side: ChatPaneNode) => {
    if (!isPaneFolded(side, routeThreadKey)) return minSize(side, routeThreadKey);
    const extent = foldedExtent(side, node.direction);
    return node.direction === "horizontal"
      ? { minWidth: extent, minHeight: 0 }
      : { minWidth: 0, minHeight: extent };
  };
  const first = sideMin(node.first);
  const second = sideMin(node.second);
  return node.direction === "horizontal"
    ? {
        minWidth: first.minWidth + second.minWidth,
        minHeight: Math.max(first.minHeight, second.minHeight),
      }
    : {
        minWidth: Math.max(first.minWidth, second.minWidth),
        minHeight: first.minHeight + second.minHeight,
      };
}

/** Pointer slop before a header press becomes a move, so plain clicks still land. */
const DRAG_DISTANCE = 6;

const PaneLeaf = memo(function PaneLeaf({
  leaf,
  edges,
  focused,
  routeThreadRef,
  fold,
  draftView,
}: {
  leaf: ChatPaneLeaf;
  edges: PaneEdges;
  focused: boolean;
  routeThreadRef: ScopedThreadRef;
  fold: PaneFold | undefined;
  /** A new thread being written here; it shows instead of the active tab. */
  draftView: ReactNode | undefined;
}) {
  const { threadRef } = leaf;
  const tabs = leafThreads(leaf);
  const follow = useFollowThread();
  const shell = useThreadShell(threadRef);
  const deleted = shell?.deletedAt != null;
  const close = useStableCallback(() => follow(closePane(leaf.id, routeThreadRef), true));
  const closeTab = (tab: ScopedThreadRef) => follow(closeThreadPane(tab, routeThreadRef), true);
  const toggleCollapsed = () => follow(togglePaneCollapsed(leaf.id, routeThreadRef));
  const activeFocused = focused && draftView === undefined;

  // A background thread deleted elsewhere takes its tab with it. The route
  // thread's tab is closed by ThreadRouteView, which also picks where to go.
  const closeDeletedTab = useStableCallback(() => closeThreadPane(threadRef, routeThreadRef));
  // oxlint-disable-next-line t3code/react-effect-budget -- reacts to a deletion pushed by the server
  useEffect(() => {
    if (deleted && !activeFocused) closeDeletedTab();
  }, [activeFocused, closeDeletedTab, deleted]);

  const cancelDragRef = useRef<(() => void) | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- ends a header drag still running at unmount
  useEffect(() => () => cancelDragRef.current?.(), []);

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const header = event.currentTarget;
    const tabElement =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-chat-pane-tab]")
        : null;
    const tabRef = tabElement ? parseScopedThreadKey(tabElement.dataset.chatPaneTab ?? "") : null;
    const onDraftTab = tabElement?.dataset.chatPaneTab === "draft";
    const dragRef = tabRef ?? threadRef;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    const finish = () => {
      cancelDragRef.current = null;
      header.removeEventListener("pointermove", onMove);
      header.removeEventListener("pointerup", onUp);
      header.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("blur", onCancel);
      if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId || onDraftTab) return;
      if (!dragging) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_DISTANCE) return;
        dragging = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        startChatPaneDrag(dragRef, leaf.id);
      }
      hoverChatPaneDrop({ x: move.clientX, y: move.clientY });
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      finish();
      if (dragging) follow(commitChatPaneDrop(routeThreadRef));
      else if (onDraftTab) return;
      else if (tabRef && scopedThreadKey(tabRef) !== scopedThreadKey(threadRef)) follow(tabRef);
      else if (tabRef && draftView === undefined) toggleCollapsed();
      else if (!activeFocused) follow(threadRef);
    };
    const onCancel = () => {
      finish();
      endChatPaneDrag();
    };
    const onKey = (key: KeyboardEvent) => {
      if (key.key !== "Escape" || !dragging) return;
      // The Escape belongs to the drag, not to whatever the focused view would close.
      key.preventDefault();
      key.stopPropagation();
      onCancel();
    };
    // Capture keeps moves coming once the pointer leaves the header or crosses embedded browsers.
    capturePointer(header, pointerId);
    header.addEventListener("pointermove", onMove);
    header.addEventListener("pointerup", onUp);
    header.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onCancel);
    cancelDragRef.current = onCancel;
  };

  const title = shell?.title ?? "Thread";
  const strip = fold === "strip";
  return (
    <section
      aria-label={title}
      className={cn("relative flex min-h-0 min-w-0 flex-1", strip ? "flex-row" : "flex-col")}
      data-chat-pane-drop={leaf.id}
      data-chat-pane-focused={focused ? "true" : "false"}
      onPointerDownCapture={(event) => {
        if (focused || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest("[data-chat-pane-header]")) {
          return;
        }
        follow(threadRef);
      }}
    >
      <div
        className={cn(
          "flex shrink-0 cursor-grab items-center gap-1.5 text-xs select-none active:cursor-grabbing [-webkit-app-region:no-drag]",
          strip ? "w-7 flex-1 flex-col py-2" : "h-7 border-b px-2",
          // Only the panes in the window's top corners sit under the traffic
          // lights or the native window controls.
          !strip && edges.top && edges.left && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          !strip && edges.top && edges.right && "wco:pr-(--workspace-native-controls-inset)",
          focused
            ? "border-b-primary/60 bg-primary/[0.06] text-foreground"
            : "border-b-border/70 text-muted-foreground",
          fold && "bg-muted/40",
        )}
        data-chat-pane-header
        // Dropping a thread anywhere on the header adds it as a tab.
        data-chat-pane-tabs={leaf.id}
        onPointerDown={onHeaderPointerDown}
      >
        <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
        {strip ? (
          <PaneTabTitle title={title} strip expanded={false} onToggle={toggleCollapsed} />
        ) : (
          <div
            role="tablist"
            aria-label="Threads in this pane"
            className="flex h-full min-w-0 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onWheel={(event) => {
              // A plain mouse wheel scrolls the tabs sideways.
              if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY;
            }}
          >
            {tabs.map((tab) => (
              <PaneTab
                key={scopedThreadKey(tab)}
                threadRef={tab}
                active={
                  draftView === undefined && scopedThreadKey(tab) === scopedThreadKey(threadRef)
                }
                expanded={fold === undefined}
                closable={tabs.length > 1 || draftView !== undefined}
                onToggle={toggleCollapsed}
                onClose={() => closeTab(tab)}
              />
            ))}
            {draftView !== undefined ? (
              <span
                ref={revealTab}
                role="tab"
                aria-selected
                className="flex shrink-0 items-center gap-1 border-b-2 border-b-primary px-2 font-medium"
                data-chat-pane-tab="draft"
              >
                <PlusIcon aria-hidden className="size-3" />
                New thread
              </span>
            ) : null}
          </div>
        )}
        {/* The gap after the tabs still moves the window, as the title bar it replaces did. */}
        <span
          aria-hidden
          className={cn(
            "flex-1",
            strip ? "w-full min-h-4" : "h-full min-w-4",
            !strip && edges.top && "drag-region",
          )}
        />
        <Button
          variant="ghost"
          size="icon-micro"
          aria-label={tabs.length > 1 ? "Close pane and its tabs" : `Close pane for ${title}`}
          title={tabs.length > 1 ? "Close pane and its tabs" : "Close pane"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={close}
        >
          <XIcon />
        </Button>
      </div>
      {fold ? null : draftView !== undefined ? (
        draftView
      ) : shell && !deleted ? (
        <ChatView
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          routeKind="server"
          paneMode={focused ? "focused" : "background"}
          reserveTitleBarControlInset={false}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Loading thread…
        </div>
      )}
      <DropHighlight paneId={leaf.id} />
    </section>
  );
});

/** Scrolls a tab that becomes active into the strip's view. */
function revealTab(node: HTMLElement | null) {
  node?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** One tab in a pane's header. The active one folds the pane when clicked, as its title did. */
function PaneTab({
  threadRef,
  active,
  expanded,
  closable,
  onToggle,
  onClose,
}: {
  threadRef: ScopedThreadRef;
  active: boolean;
  expanded: boolean;
  closable: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  const title = useThreadShell(threadRef)?.title ?? "Thread";
  return (
    <div
      ref={active ? revealTab : undefined}
      role="tab"
      aria-selected={active}
      className={cn(
        "group/tab flex max-w-48 min-w-0 shrink-0 items-center gap-0.5 border-b-2 pl-2",
        closable ? "pr-0.5" : "pr-2",
        active ? "border-b-primary text-foreground" : "border-b-transparent hover:text-foreground",
      )}
      data-chat-pane-tab={scopedThreadKey(threadRef)}
    >
      <PaneTabTitle
        title={title}
        strip={false}
        expanded={expanded}
        onToggle={active ? onToggle : undefined}
      />
      {closable ? (
        <span
          className={cn(
            "flex",
            !active && "opacity-0 group-hover/tab:opacity-100 focus-within:opacity-100",
          )}
        >
          <Button
            variant="ghost"
            size="icon-micro"
            aria-label={`Close tab ${title}`}
            title="Close tab"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
}

function PaneTabTitle({
  title,
  strip,
  expanded,
  onToggle,
}: {
  title: string;
  strip: boolean;
  expanded: boolean;
  /** Set on the active tab, whose title folds and unfolds the pane. */
  onToggle: (() => void) | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="button"
            tabIndex={0}
            aria-expanded={onToggle ? expanded : undefined}
            className={cn(
              "min-w-0 cursor-pointer truncate rounded-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              strip && "min-h-0 [writing-mode:vertical-rl]",
            )}
            data-chat-pane-title
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onToggle?.();
            }}
          />
        }
      >
        {title}
      </TooltipTrigger>
      <TooltipPopup side={strip ? "right" : "bottom"}>{title}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The gutter between two panes. The live ratio goes straight to the
 * container's CSS variable and is committed on release, so a drag never
 * re-renders the chat views on either side per frame.
 */
const KEYBOARD_RATIO_STEP = 0.05;

function ResizeHandle({
  direction,
  ratio,
  containerRef,
  onCommit,
}: {
  direction: SplitDirection;
  ratio: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onCommit: (ratio: number) => void;
}) {
  const ratioRef = useRef<number | null>(null);
  const horizontal = direction === "horizontal";
  const ratioFromPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return clampPaneRatio(
      horizontal
        ? (event.clientX - rect.left) / rect.width
        : (event.clientY - rect.top) / rect.height,
    );
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const dragged = ratioRef.current;
    if (dragged === null) return;
    ratioRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    onCommit(dragged);
  };
  // An unmount mid-drag never sees the release, so the body styles go with it.
  // oxlint-disable-next-line t3code/react-effect-budget -- restores body styles a resize left behind
  useEffect(
    () => () => {
      if (ratioRef.current === null) return;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [],
  );
  const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
  const increase = horizontal ? "ArrowRight" : "ArrowDown";
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      data-chat-pane-resize
      aria-label="Resize panes"
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      onKeyDown={(event) => {
        const step =
          event.key === decrease
            ? -KEYBOARD_RATIO_STEP
            : event.key === increase
              ? KEYBOARD_RATIO_STEP
              : 0;
        const next =
          event.key === "Home" ? 0 : event.key === "End" ? 1 : step !== 0 ? ratio + step : null;
        if (next === null) return;
        event.preventDefault();
        onCommit(clampPaneRatio(next));
      }}
      className={cn(
        "group relative z-20 shrink-0 bg-border outline-none select-none focus-visible:bg-primary",
        horizontal ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        capturePointer(event.currentTarget, event.pointerId);
        document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";
        ratioRef.current = ratioFromPointer(event) ?? 0.5;
      }}
      onPointerMove={(event) => {
        if (ratioRef.current === null) return;
        const ratio = ratioFromPointer(event);
        if (ratio === null) return;
        ratioRef.current = ratio;
        containerRef.current?.style.setProperty("--pane-ratio", String(ratio));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => useChatPanesStore.getState().equalize()}
    >
      <span
        aria-hidden
        className={cn(
          "absolute group-hover:bg-primary/50 group-active:bg-primary",
          horizontal ? "inset-y-0 -left-1 w-2" : "inset-x-0 -top-1 h-2",
        )}
      />
    </div>
  );
}
