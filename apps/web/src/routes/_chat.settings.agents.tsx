import { createFileRoute } from "@tanstack/react-router";

import { AgentsSettings } from "../components/settings/AgentsSettings";

export const Route = createFileRoute("/_chat/settings/agents")({
  component: AgentsSettings,
});
