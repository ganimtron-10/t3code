import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { collectLeaves, findLeafByThread } from "./chatPanes.logic";
import {
  SOLO_PANE_ID,
  canOpenThreadInSplit,
  closePane,
  closeRouteThreadPane,
  openThreadInSplit,
  placeThread,
  selectRouteLayout,
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
  beforeEach(() => useChatPanesStore.setState({ root: null, drag: null }));

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
});
