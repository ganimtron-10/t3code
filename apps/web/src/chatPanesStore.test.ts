import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { collectLeaves, findLeafByThread } from "./chatPanes.logic";
import {
  SOLO_PANE_ID,
  attachThreadToFocusedPane,
  canOpenThreadInSplit,
  closePane,
  closeRouteThreadPane,
  closeThreadPane,
  focusThreadPane,
  openThreadInSplit,
  placeThread,
  selectRouteLayout,
  togglePaneCollapsed,
  useChatPanesStore,
} from "./chatPanesStore";

const ref = (threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(threadId),
});
const threads = () => {
  const { root } = useChatPanesStore.getState();
  return root ? collectLeaves(root).map((leaf) => leaf.threadRef.threadId) : [];
};
const paneOf = (threadId: string) =>
  findLeafByThread(useChatPanesStore.getState().root, ref(threadId))!.id;

describe("chat panes store", () => {
  beforeEach(() => useChatPanesStore.setState({ root: null, focusedPaneId: null, drag: null }));

  it("starts a layout from the thread shown on its own", () => {
    expect(placeThread(ref("a"), ref("b"), { paneId: SOLO_PANE_ID, zone: "left" })).toBe(true);
    expect(threads()).toEqual(["b", "a"]);
    expect(placeThread(ref("a"), ref("a"), { paneId: SOLO_PANE_ID, zone: "left" })).toBe(false);
  });

  it("moves a thread already in the layout instead of opening it twice", () => {
    openThreadInSplit(ref("a"), ref("b"));
    openThreadInSplit(ref("a"), ref("c"));
    expect(threads()).toEqual(["a", "c", "b"]);
    expect(canOpenThreadInSplit(ref("a"), ref("b"))).toBe(false);
    placeThread(ref("a"), ref("b"), { paneId: paneOf("a"), zone: "left" });
    expect(threads()).toEqual(["b", "a", "c"]);
  });

  it("replaces the saved layout when a thread outside it starts a new one", () => {
    openThreadInSplit(ref("a"), ref("b"));
    expect(selectRouteLayout(useChatPanesStore.getState().root, ref("z"))).toBeNull();
    openThreadInSplit(ref("z"), ref("y"));
    expect(threads()).toEqual(["z", "y"]);
  });

  it("hands the route to a surviving pane and drops a one-pane layout", () => {
    openThreadInSplit(ref("a"), ref("b"));
    openThreadInSplit(ref("a"), ref("c"));
    expect(closePane(paneOf("b"), ref("a"))).toBeNull();
    expect(threads()).toEqual(["a", "c"]);
    expect(closeRouteThreadPane(ref("a"))?.threadId).toBe("c");
    expect(useChatPanesStore.getState().root).toBeNull();
  });

  it("closes a settled thread's pane and hands the route on when it was focused", () => {
    openThreadInSplit(ref("a"), ref("b"));
    openThreadInSplit(ref("a"), ref("c"));
    expect(closeThreadPane(ref("c"), ref("a"))).toBeNull();
    expect(threads()).toEqual(["a", "b"]);
    expect(closeThreadPane(ref("z"), ref("a"))).toBeNull();
    expect(closeThreadPane(ref("a"), ref("a"))?.threadId).toBe("b");
    expect(useChatPanesStore.getState().root).toBeNull();
  });

  it("folds a pane, moving focus off it first, and never folds the last open one", () => {
    openThreadInSplit(ref("a"), ref("b"));
    const collapsed = (threadId: string) =>
      findLeafByThread(useChatPanesStore.getState().root, ref(threadId))!.collapsed === true;

    expect(togglePaneCollapsed(paneOf("b"), ref("a"))).toBeNull();
    expect(collapsed("b")).toBe(true);
    expect(togglePaneCollapsed(paneOf("a"), ref("a"))).toBeNull();
    expect(collapsed("a")).toBe(false);

    expect(togglePaneCollapsed(paneOf("b"), ref("a"))).toBeNull();
    expect(collapsed("b")).toBe(false);
    expect(togglePaneCollapsed(paneOf("a"), ref("a"))?.threadId).toBe("b");
    expect(collapsed("a")).toBe(true);

    focusThreadPane(ref("a"));
    expect(collapsed("a")).toBe(false);
  });

  const tabsOf = (threadId: string) => {
    const leaf = findLeafByThread(useChatPanesStore.getState().root, ref(threadId))!;
    return (leaf.tabs ?? [leaf.threadRef]).map((tab) => tab.threadId);
  };

  it("opens a thread from outside the layout as a tab of the focused pane", () => {
    openThreadInSplit(ref("a"), ref("b"));
    focusThreadPane(ref("b"));
    expect(attachThreadToFocusedPane(ref("c"))).toBe(true);
    expect(tabsOf("c")).toEqual(["b", "c"]);
    expect(paneOf("c")).toBe(paneOf("b"));
    expect(attachThreadToFocusedPane(ref("c"))).toBe(false);
  });

  it("does not attach without a layout", () => {
    expect(attachThreadToFocusedPane(ref("c"))).toBe(false);
    expect(useChatPanesStore.getState().root).toBeNull();
  });

  it("closing a tab keeps its pane and hands the route to the neighbour", () => {
    openThreadInSplit(ref("a"), ref("b"));
    focusThreadPane(ref("b"));
    attachThreadToFocusedPane(ref("c"));
    expect(closeThreadPane(ref("c"), ref("c"))).toEqual(ref("b"));
    expect(tabsOf("b")).toEqual(["b"]);
    expect(threads()).toEqual(["a", "b"]);
  });

  it("keeps one pane with several tabs as a layout", () => {
    openThreadInSplit(ref("a"), ref("b"));
    focusThreadPane(ref("a"));
    attachThreadToFocusedPane(ref("c"));
    expect(closeThreadPane(ref("b"), ref("a"))).toBeNull();
    expect(tabsOf("a")).toEqual(["a", "c"]);
    expect(closeThreadPane(ref("c"), ref("a"))).toBeNull();
    expect(useChatPanesStore.getState().root).toBeNull();
  });

  it("drops a thread on a tab strip as a tab, and splits a tab out of its pane", () => {
    openThreadInSplit(ref("a"), ref("b"));
    expect(placeThread(ref("a"), ref("c"), { paneId: paneOf("a"), zone: "tabs" })).toBe(true);
    expect(tabsOf("a")).toEqual(["a", "c"]);
    expect(placeThread(ref("a"), ref("c"), { paneId: paneOf("a"), zone: "bottom" })).toBe(true);
    expect(tabsOf("a")).toEqual(["a"]);
    expect(threads()).toEqual(["a", "c", "b"]);
    expect(placeThread(ref("a"), ref("b"), { paneId: paneOf("c"), zone: "tabs" })).toBe(true);
    expect(tabsOf("c")).toEqual(["c", "b"]);
  });

  it("focusing a tab makes it active", () => {
    openThreadInSplit(ref("a"), ref("b"));
    focusThreadPane(ref("a"));
    attachThreadToFocusedPane(ref("c"));
    focusThreadPane(ref("a"));
    expect(findLeafByThread(useChatPanesStore.getState().root, ref("a"))!.threadRef).toEqual(
      ref("a"),
    );
  });
});
