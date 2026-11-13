import { AgentSoulError, isAgentBotId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";

const AGENT_SOUL_FILE_NAME = "SOUL.md";

/** Each bot's persona lives in `<T3 home>/agents/<bot id>/SOUL.md`, editable on disk or in Settings. */
export class AgentSouls extends Context.Service<
  AgentSouls,
  {
    /** Null when the file is missing or the id cannot have one, so the caller falls back to the inline instructions. */
    readonly read: (id: string) => Effect.Effect<string | null, AgentSoulError>;
    readonly write: (id: string, content: string) => Effect.Effect<void, AgentSoulError>;
    /** Removes the bot's whole folder; a missing folder is not an error. */
    readonly remove: (id: string) => Effect.Effect<void, AgentSoulError>;
  }
>()("t3/provider/AgentSouls") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig;
  const agentsDir = path.join(baseDir, "agents");

  // The id is the only caller-controlled part of the path, so it must be a plain slug.
  const botDir = (id: string, operation: AgentSoulError["operation"]) =>
    isAgentBotId(id)
      ? Effect.succeed(path.join(agentsDir, id))
      : Effect.fail(new AgentSoulError({ id, operation }));

  const read = Effect.fn("AgentSouls.read")(function* (id: string) {
    // A profile saved by hand with a non-slug id can have no file; it keeps its inline rules.
    if (!isAgentBotId(id)) return null;
    const filePath = path.join(yield* botDir(id, "read"), AGENT_SOUL_FILE_NAME);
    return yield* fs.readFileString(filePath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(null)
            : Effect.fail(new AgentSoulError({ id, operation: "read", cause: error })),
      }),
    );
  });

  const write = Effect.fn("AgentSouls.write")(function* (id: string, content: string) {
    const dir = yield* botDir(id, "write");
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(path.join(dir, AGENT_SOUL_FILE_NAME), content)),
      Effect.mapError((cause) => new AgentSoulError({ id, operation: "write", cause })),
    );
  });

  const remove = Effect.fn("AgentSouls.remove")(function* (id: string) {
    const dir = yield* botDir(id, "remove");
    yield* fs
      .remove(dir, { recursive: true, force: true })
      .pipe(Effect.mapError((cause) => new AgentSoulError({ id, operation: "remove", cause })));
  });

  return AgentSouls.of({ read, write, remove });
});

export const layer = Layer.effect(AgentSouls, make);

/** No SOUL.md files, for tests that do not exercise them. */
export const layerEmpty = Layer.mock(AgentSouls)({ read: () => Effect.succeed(null) });
