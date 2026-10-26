import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectLeaves,
  equalizePanes,
  findLeafByThread,
  findNode,
  isPaneFolded,
  isRestorableLayout,
  movePane,
  removePane,
  resolveDropZone,
  resolveEdgeDropZone,
  setPaneCollapsed,
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

  it("gives every pane along an axis the same share", () => {
    // a | (b / c) | d: three columns, with b and c stacked in the middle one.
    const layout = splitPane(
      splitPane(
        splitPane(leaf("a"), "a", "right", leaf("b"), "s1"),
        "b",
        "bottom",
        leaf("c"),
        "s2",
      ),
      "s1",
      "right",
      leaf("d"),
      "s3",
    );
    const skewed = setPaneRatio(setPaneRatio(layout, "s1", 0.8), "s2", 0.2);
    const even = equalizePanes(skewed);
    expect(even).toMatchObject({ id: "s3", ratio: 2 / 3, first: { id: "s1", ratio: 0.5 } });
    expect(findNode(even, "s2")).toMatchObject({ ratio: 0.5 });
    expect(equalizePanes(even)).toBe(even);
  });

  it("rejects saved layouts that repeat a pane or thread, or hold too many panes", () => {
    const layout = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(isRestorableLayout(layout)).toBe(true);
    expect(isRestorableLayout(splitPane(leaf("a"), "a", "right", leaf("a"), "s1"))).toBe(false);
    expect(isRestorableLayout({ ...layout, id: "a" })).toBe(false);
    let deep: ChatPaneNode = leaf("t0");
    for (let i = 1; i <= 2000; i++)
      deep = splitPane(deep, deep.id, "right", leaf(`t${i}`), `s${i}`);
    expect(isRestorableLayout(deep)).toBe(false);
  });

  it("finds the pane showing a thread", () => {
    const layout = splitPane(leaf("a"), "a", "right", leaf("b"), "s1");
    expect(findLeafByThread(layout, ref("b"))?.id).toBe("b");
    expect(findLeafByThread(layout, ref("z"))).toBeNull();
  });
});

describe("collapsed panes", () => {
  const key = (id: string) => scopedThreadKey(ref(id));
  const layout = (): ChatPaneNode => ({
    kind: "split",
    id: "s1",
    direction: "horizontal",
    ratio: 0.5,
    first: leaf("a"),
    second: {
      kind: "split",
      id: "s2",
      direction: "vertical",
      ratio: 0.5,
      first: leaf("b"),
      second: leaf("c"),
    },
  });

  it("folds and unfolds one pane and keeps the tree for a no-op", () => {
    const root = layout();
    const folded = setPaneCollapsed(root, "b", true);
    expect(findNode(folded, "b")).toMatchObject({ collapsed: true });
    expect(findNode(folded, "c")).not.toHaveProperty("collapsed");
    expect(setPaneCollapsed(folded, "b", true)).toBe(folded);
    expect(setPaneCollapsed(root, "missing", true)).toBe(root);
    expect(findNode(setPaneCollapsed(folded, "b", false), "b")).toEqual(leaf("b"));
  });

  it("treats a subtree as folded only when every pane in it is, focus excepted", () => {
    const root = setPaneCollapsed(setPaneCollapsed(layout(), "b", true), "c", true);
    const right = root.kind === "split" ? root.second : root;
    expect(isPaneFolded(right, key("a"))).toBe(true);
    expect(isPaneFolded(right, key("c"))).toBe(false);
    expect(isPaneFolded(setPaneCollapsed(right, "c", false), key("a"))).toBe(false);
  });

  it("carries the folded flag when a pane moves", () => {
    const moved = movePane(setPaneCollapsed(layout(), "b", true), "b", "a", "left", "s3");
    expect(findNode(moved, "b")).toMatchObject({ collapsed: true });
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
