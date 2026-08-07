import {
  defaultSpec,
  focusedPipelineSpec,
  meetingPrepSpec,
  pipelineSpec,
  type WorkspaceSpec,
} from "./spec.js";

export type AgentReply = {
  spec: WorkspaceSpec;
  message: string;
};

/**
 * Prototype "agent": intent matching over the command text, returning a new
 * workspace spec. In the real product this is the LLM emitting a layout spec
 * over the same primitives; here it's scripted so the interaction is demoable.
 */
export function runCommand(input: string, current: WorkspaceSpec): AgentReply {
  const q = input.toLowerCase();

  const amountMatch = q.match(/\$?(\d+)\s*k/);
  const minAmount = amountMatch ? parseInt(amountMatch[1], 10) * 1000 : 25000;

  if (/(quiet|under \$|don't care|do not care|focus|filter)/.test(q) && current.id !== "home") {
    return {
      spec: focusedPipelineSpec(minAmount),
      message: `Done — filtered to deals ≥ $${minAmount / 1000}K, pulled the quiet ones out, and put today's meetings on top.`,
    };
  }

  if (/pipeline/.test(q)) {
    return {
      spec: pipelineSpec(),
      message: "Here's your pipeline workspace — deals by stage, totals, and the full list. Tell me what to change.",
    };
  }

  if (/meeting|prep|prepare/.test(q)) {
    return {
      spec: meetingPrepSpec(),
      message: "Assembled a meeting-prep surface — briefs for each meeting today, account context, and suggested prep tasks.",
    };
  }

  if (/quiet/.test(q)) {
    return {
      spec: focusedPipelineSpec(0),
      message: "Pulled out every deal with no meaningful touch in 7+ days.",
    };
  }

  if (/reset|home|start over/.test(q)) {
    return { spec: defaultSpec(), message: "Back to a blank surface. What do you want to work on?" };
  }

  return {
    spec: current,
    message:
      "I'm a scripted prototype, so I only know a few moves: try “help me manage my pipeline”, “show me deals going quiet”, or “help me prepare for my meetings”.",
  };
}
