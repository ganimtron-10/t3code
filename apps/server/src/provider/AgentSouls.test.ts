import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as AgentSouls from "./AgentSouls.ts";

const layer = AgentSouls.layer.pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-souls-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("AgentSouls", (it) => {
  it.effect("writes, reads back and removes a bot's SOUL.md under <home>/agents/<id>", () =>
    Effect.gen(function* () {
      const souls = yield* AgentSouls.AgentSouls;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      const file = path.join(baseDir, "agents", "reviewer", "SOUL.md");

      assert.isNull(yield* souls.read("reviewer"));
      yield* souls.write("reviewer", "# Reviewer\n\nReview diffs.");
      assert.equal(yield* fs.readFileString(file), "# Reviewer\n\nReview diffs.");
      // Edits made on disk are what the next read returns.
      yield* fs.writeFileString(file, "Edited by hand.");
      assert.equal(yield* souls.read("reviewer"), "Edited by hand.");

      yield* souls.remove("reviewer");
      assert.isFalse(yield* fs.exists(path.dirname(file)));
      assert.isNull(yield* souls.read("reviewer"));
      yield* souls.remove("reviewer");
    }),
  );

  it.effect("refuses ids that are not plain slugs, so no path leaves the agents folder", () =>
    Effect.gen(function* () {
      const souls = yield* AgentSouls.AgentSouls;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir } = yield* ServerConfig.ServerConfig;
      for (const id of ["../escape", "..", "a/b", "/etc/passwd", "Reviewer", "a.b", ""]) {
        assert.isTrue(Exit.isFailure(yield* Effect.exit(souls.write(id, "x"))), id);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(souls.read(id))), id);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(souls.remove(id))), id);
      }
      assert.isFalse(yield* fs.exists(path.join(baseDir, "escape")));
    }),
  );
});
