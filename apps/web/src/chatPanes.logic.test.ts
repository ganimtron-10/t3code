import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLeaves,
  findLeafByThread,
  movePane,
  removePane,
  resolveDropZone,
  resolveEdgeDropZone,
  setPaneRatio,
  splitPane,
  type ChatPaneLeaf,
  type ChatPaneNode,
} from "./chatPanes.logic";

const ref = (threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(threadId),
});
const leaf = (id: string): ChatPaneLeaf => ({ kind: "leaf", id, threadRef: ref(id) });
const order = (node: ChatPaneNode | null) =>
  node ? collectLeaves(node).map((pane) => pane.id) : [];

describe("chat pane tree", () => {
  it("splits a pane on the dropped side", () => {
    const a = leaf("a");
    const right = splitPane(a, "a", "right", leaf("b"), "s1");
    expect(right).toMatchObject({ kind: "split", direction: "horizontal", ratio: 0.5 });
    expect(order(right)).toEqual(["a", "b"]);

    const top = splitPane(right, "b", "top", leaf("c"), "s2");
    expect(order(top)).toEqual(["a", "c", "b"]);
    expect(top.kind === "split" && top.second).toMatchObject({ direction: "vertical" });
  });

  it("wraps the whole layout when the root is the target", () => {
    const layout = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    const bottom = splitPane(layout, "s1", "bottom", leaf("c"), "s2");
    expect(bottom).toMatchObject({ id: "s2", direction: "vertical" });
    expect(order(bottom)).toEqual(["a", "b", "c"]);
  });

  it("collapses a split into the surviving sibling", () => {
    const layout = splitPane(
      splitPane(leaf("a"), "a", "right", leaf("b"), "s1"),
      "b",
      "bottom",
      leaf("c"),
      "s2",
    );
    const withoutC = removePane(layout, "c");
    expect(order(withoutC)).toEqual(["a", "b"]);
    expect(withoutC).toMatchObject({ id: "s1" });
    expect(removePane(removePane(withoutC!, "b")!, "a")).toBeNull();
  });

  it("moves a pane next to another and keeps unrelated nodes", () => {
    const layout = splitPane(
      splitPane(leaf("a"), "a", "right", leaf("b"), "s1"),
      "b",
      "right",
      leaf("c"),
      "s2",
    );
    const moved = movePane(layout, "c", "a", "left", "s3");
    expect(order(moved)).toEqual(["c", "a", "b"]);
    expect(movePane(layout, "a", "a", "left", "s4")).toBe(layout);
  });

  it("moves a pane onto the edge of a root its removal collapsed", () => {
    const layout = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    const moved = movePane(layout, "b", "s1", "top", "s2");
    expect(moved).toMatchObject({ direction: "vertical" });
    expect(order(moved)).toEqual(["b", "a"]);
  });

  it("clamps ratios and returns the same tree for a no-op", () => {
    const layout = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(setPaneRatio(layout, "s1", 0.5)).toBe(layout);
    expect(setPaneRatio(layout, "s1", 2)).toMatchObject({ ratio: 0.85 });
  });

  it("finds the pane showing a thread", () => {
    const layout = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(findLeafByThread(layout, ref("b"))?.id).toBe("b");
    expect(findLeafByThread(layout, ref("z"))).toBeNull();
  });
});

describe("drop zones", () => {
  const rect = { left: 0, top: 0, width: 300, height: 200 };

  it("prefers the long axis near its ends and the short axis in the middle", () => {
    expect(resolveDropZone(rect, 20, 100)).toBe("left");
    expect(resolveDropZone(rect, 290, 100)).toBe("right");
    expect(resolveDropZone(rect, 150, 40)).toBe("top");
    expect(resolveDropZone(rect, 150, 180)).toBe("bottom");
    expect(resolveDropZone(rect, 400, 100)).toBeNull();
  });

  it("targets the layout only inside its edge band", () => {
    expect(resolveEdgeDropZone(rect, 5, 100)).toBe("left");
    expect(resolveEdgeDropZone(rect, 150, 195)).toBe("bottom");
    expect(resolveEdgeDropZone(rect, 150, 100)).toBeNull();
  });
});
