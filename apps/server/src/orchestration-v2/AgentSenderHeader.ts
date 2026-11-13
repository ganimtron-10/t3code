import {
  type AgentProfile,
  findAgentProfile,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";

/**
 * Agents otherwise cannot tell which teammate wrote a message. Only messages
 * that involve a profiled thread get the header, so threads without a profile
 * keep today's provider input.
 */
export function agentSenderHeader(input: {
  readonly message: Pick<OrchestrationV2ConversationMessage, "createdBy" | "senderThreadId">;
  readonly recipient: OrchestrationV2AppThread;
  readonly sender: OrchestrationV2AppThread | undefined;
  readonly profiles?: ReadonlyArray<AgentProfile>;
}): string | undefined {
  const { message, recipient, sender } = input;
  if (
    message.createdBy !== "agent" ||
    sender === undefined ||
    sender.id !== message.senderThreadId ||
    sender.id === recipient.id ||
    (sender.agentProfileId === undefined && recipient.agentProfileId === undefined)
  ) {
    return undefined;
  }
  const name =
    findAgentProfile(input.profiles ?? [], sender.agentProfileId)?.name ??
    sender.agentProfileId ??
    `"${sender.title}"`;
  return `[From ${name} (thread ${sender.id})]`;
}

/**
 * The thread's own agent still takes a message that tags bots, so it is told who joined
 * and that their results arrive here, instead of looking for a teammate it cannot see.
 */
export function agentMentionNote(bots: ReadonlyArray<AgentProfile>): string | undefined {
  if (bots.length === 0) return undefined;
  const names = bots.map((bot) => `${bot.name} (@${bot.id})`).join(", ");
  return `[Tagged bots: ${names}. T3 Code already handed this message to each of them as a delegated task under this thread; their results arrive here when they finish. Answer the rest of the message yourself and leave their part to them.]`;
}

export function withAgentSenderHeader(text: string, header: string | undefined): string {
  return header === undefined ? text : `${header}\n\n${text}`;
}
