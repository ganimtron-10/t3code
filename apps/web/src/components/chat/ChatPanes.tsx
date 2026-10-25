import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GripVerticalIcon, XIcon } from "lucide-react";
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
  paneSpan,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type DropZone,
  type SplitDirection,
} from "~/chatPanes.logic";
import {
  closePane,
  commitChatPaneDrop,
  endChatPaneDrag,
  expandThreadPane,
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
};

const EDGE_ZONE_CLASS: Record<DropZone, string> = {
  top: "inset-x-0 top-0 h-1/3",
  bottom: "inset-x-0 bottom-0 h-1/3",
  left: "inset-y-0 left-0 w-1/3",
  right: "inset-y-0 right-0 w-1/3",
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
}: {
  root: ChatPaneNode;
  routeThreadRef: ScopedThreadRef;
}) {
  const routeThreadKey = scopedThreadKey(routeThreadRef);
  // Focusing a folded pane, from the sidebar or a reload, opens it back up.
  useEffect(() => expandThreadPane(routeThreadRef), [routeThreadRef]);
  return (
    <div
      // Panes keep a readable minimum size; past that the layout scrolls instead of crushing them.
      className="relative flex min-h-0 min-w-0 flex-1 overflow-auto bg-background"
      data-chat-panes-root={root.id}
    >
      <div className="flex flex-1" style={minSize(root, routeThreadKey)}>
        <PaneNode
          node={root}
          edges={WINDOW_TOP_EDGES}
          routeThreadKey={routeThreadKey}
          routeThreadRef={routeThreadRef}
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

/** How a folded pane draws its header: a bar across a column, or a strip down a row. */
type PaneFold = "bar" | "strip";

interface PaneNodeProps {
  node: ChatPaneNode;
  edges: PaneEdges;
  routeThreadKey: string;
  routeThreadRef: ScopedThreadRef;
  /** Set inside a run of folded panes, which share the space their headers need. */
  fold?: PaneFold | undefined;
}

function PaneNode({ node, edges, routeThreadKey, routeThreadRef, fold }: PaneNodeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  if (node.kind === "leaf") {
    return (
      <PaneLeaf
        leaf={node}
        edges={edges}
        focused={scopedThreadKey(node.threadRef) === routeThreadKey}
        routeThreadRef={routeThreadRef}
        fold={fold}
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
}: {
  leaf: ChatPaneLeaf;
  edges: PaneEdges;
  focused: boolean;
  routeThreadRef: ScopedThreadRef;
  fold: PaneFold | undefined;
}) {
  const { threadRef } = leaf;
  const follow = useFollowThread();
  const shell = useThreadShell(threadRef);
  const deleted = shell?.deletedAt != null;
  const close = useStableCallback(() => follow(closePane(leaf.id, routeThreadRef), true));
  const toggleCollapsed = () => follow(togglePaneCollapsed(leaf.id, routeThreadRef));

  // A background thread deleted elsewhere takes its pane with it. The route
  // thread's pane is closed by ThreadRouteView, which also picks where to go.
  useEffect(() => {
    if (deleted && !focused) close();
  }, [close, deleted, focused]);

  const cancelDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelDragRef.current?.(), []);

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const header = event.currentTarget;
    const onTitle =
      event.target instanceof Element && event.target.closest("[data-chat-pane-title]") !== null;
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
      if (move.pointerId !== pointerId) return;
      if (!dragging) {
        if (Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_DISTANCE) return;
        dragging = true;
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        startChatPaneDrag(threadRef, leaf.id);
      }
      hoverChatPaneDrop({ x: move.clientX, y: move.clientY });
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      finish();
      if (dragging) follow(commitChatPaneDrop(routeThreadRef));
      else if (onTitle) toggleCollapsed();
      else if (!focused) follow(threadRef);
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
        onPointerDown={onHeaderPointerDown}
      >
        <GripVerticalIcon aria-hidden className="size-3.5 shrink-0 opacity-60" />
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="button"
                tabIndex={0}
                aria-expanded={fold === undefined}
                className={cn(
                  "min-w-0 cursor-pointer truncate font-medium hover:text-foreground",
                  strip && "min-h-0 [writing-mode:vertical-rl]",
                )}
                data-chat-pane-title
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  toggleCollapsed();
                }}
              />
            }
          >
            {title}
          </TooltipTrigger>
          <TooltipPopup side={strip ? "right" : "bottom"}>{title}</TooltipPopup>
        </Tooltip>
        {/* The gap after the title still moves the window, as the title bar it replaces did. */}
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
          aria-label={`Close pane for ${title}`}
          title="Close pane"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={close}
        >
          <XIcon />
        </Button>
      </div>
      {fold ? null : shell && !deleted ? (
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
