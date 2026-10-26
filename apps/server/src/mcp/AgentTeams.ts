import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";

/** A Chief plus this many profiled members working at once. */
export const TEAM_MAX_MEMBERS = 6;
/** Messages two members may send each other before the pair must go through the Chief. */
export const TEAM_PAIR_MESSAGE_CAP = 8;

interface ThreadWithMessages {
  readonly thread: OrchestrationV2AppThread;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

/**
 * Profiled threads in the same team where neither delegated to the other.
 * Parent and child already talk through delegated task results, so only these
 * pairs need reply wakes and the ping-pong cap. Threads without a profile keep
 * today's behavior.
 */
export function areTeamSiblings(
  left: OrchestrationV2AppThread,
  right: OrchestrationV2AppThread,
): boolean {
  return (
    left.agentProfileId !== undefined &&
    right.agentProfileId !== undefined &&
    left.id !== right.id &&
    left.lineage.rootThreadId === right.lineage.rootThreadId &&
    left.lineage.parentThreadId !== right.id &&
    right.lineage.parentThreadId !== left.id
  );
}

/** Agent-to-agent messages either thread sent the other through t3_thread_send. */
export function countPairMessages(left: ThreadWithMessages, right: ThreadWithMessages): number {
  const sent = (inbox: ThreadWithMessages, sender: OrchestrationV2AppThread) =>
    inbox.messages.filter(
      (message) =>
        message.createdBy === "agent" &&
        message.creationSource === "mcp" &&
        message.senderThreadId === sender.id,
    ).length;
  return sent(right, left.thread) + sent(left, right.thread);
}

/** Why a thread may not add another profiled member, or undefined when it may. */
export function teamDelegationRejection(
  parent: OrchestrationV2AppThread,
  activeMembers: number,
): string | undefined {
  // Any delegated thread, profiled or not, would otherwise nest a second team
  // that t3_team_list on the root cannot see.
  if (parent.lineage.relationshipToParent === "subagent") {
    return `Only a top-level thread can lead a team, and this thread was delegated. Ask your Chief (thread ${parent.lineage.rootThreadId}) with t3_thread_send instead.`;
  }
  if (activeMembers >= TEAM_MAX_MEMBERS) {
    return `This team already has ${TEAM_MAX_MEMBERS} active members. Wait for one to finish, or stop one with task_cancel, before adding another.`;
  }
  return undefined;
}

/** Why a member may not message a sibling again, or undefined when it may. */
export function pairCapRejection(
  sender: ThreadWithMessages,
  recipient: ThreadWithMessages,
): string | undefined {
  if (!areTeamSiblings(sender.thread, recipient.thread)) return undefined;
  if (countPairMessages(sender, recipient) < TEAM_PAIR_MESSAGE_CAP) return undefined;
  return `You and thread ${recipient.thread.id} have already exchanged ${TEAM_PAIR_MESSAGE_CAP} messages. Stop and report where you disagree or are stuck to your Chief (thread ${sender.thread.lineage.rootThreadId}) with t3_thread_send.`;
}
