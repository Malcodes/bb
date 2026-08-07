import { meetings, opportunities, type Meeting, type Opportunity } from "./data.js";

export type Block =
  | { kind: "metrics"; items: { label: string; value: string; hint?: string }[] }
  | { kind: "table"; title: string; columns: string[]; rows: string[][]; badges?: (number | null)[] }
  | { kind: "kanban"; title: string; lanes: { name: string; cards: { title: string; sub: string; flag?: string }[] }[] }
  | { kind: "timeline"; title: string; items: { time: string; title: string; sub: string }[] }
  | { kind: "cards"; title: string; cards: { title: string; sub: string; body: string; flag?: string }[] }
  | { kind: "list"; title: string; items: { title: string; sub: string }[] };

export type WorkspaceSpec = {
  id: string;
  title: string;
  subtitle: string;
  blocks: Block[];
};

export const fmt = (n: number) =>
  n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;

const QUIET_DAYS = 7;

export function isQuiet(o: Opportunity) {
  return o.lastTouchDays >= QUIET_DAYS;
}

export function pipelineSpec(): WorkspaceSpec {
  const open = opportunities.filter((o) => o.stage !== "Closed Won");
  const total = open.reduce((s, o) => s + o.amount, 0);
  const closingSoon = open.filter((o) => ["Negotiation", "Proposal"].includes(o.stage));
  const stages = ["Discovery", "Qualification", "Demo", "Proposal", "Negotiation"] as const;
  return {
    id: "pipeline",
    title: "Pipeline",
    subtitle: `${open.length} open opportunities · ${fmt(total)} total`,
    blocks: [
      {
        kind: "metrics",
        items: [
          { label: "Open pipeline", value: fmt(total) },
          { label: "Open deals", value: String(open.length) },
          { label: "Closing this month", value: fmt(closingSoon.reduce((s, o) => s + o.amount, 0)), hint: `${closingSoon.length} deals` },
          { label: "Going quiet", value: String(open.filter(isQuiet).length), hint: `no touch in ${QUIET_DAYS}+ days` },
        ],
      },
      {
        kind: "kanban",
        title: "Deals by stage",
        lanes: stages.map((s) => ({
          name: s,
          cards: open.filter((o) => o.stage === s).map((o) => ({
            title: o.account,
            sub: `${fmt(o.amount)} · closes ${o.closeDate}`,
            flag: isQuiet(o) ? `${o.lastTouchDays}d quiet` : undefined,
          })),
        })),
      },
      {
        kind: "table",
        title: "All open opportunities",
        columns: ["Deal", "Account", "Amount", "Stage", "Close", "Last touch"],
        rows: open.map((o) => [o.name, o.account, fmt(o.amount), o.stage, o.closeDate, `${o.lastTouchDays}d ago`]),
      },
    ],
  };
}

export function focusedPipelineSpec(minAmount: number): WorkspaceSpec {
  const base = pipelineSpec();
  const keep = opportunities.filter((o) => o.stage !== "Closed Won" && o.amount >= minAmount);
  const quiet = keep.filter(isQuiet);
  const todayByAccount = new Map(meetings.map((m) => [m.account, m]));
  const stages = ["Discovery", "Qualification", "Demo", "Proposal", "Negotiation"] as const;
  return {
    ...base,
    subtitle: `${keep.length} deals ≥ ${fmt(minAmount)} · quiet deals highlighted · today's meetings first`,
    blocks: [
      {
        kind: "timeline",
        title: "Today's meetings",
        items: meetings.map((m) => ({ time: m.time, title: m.title, sub: `${m.account} · ${m.attendees.join(", ")}` })),
      },
      {
        kind: "cards",
        title: "Going quiet — needs attention",
        cards: quiet.map((o) => ({
          title: o.account,
          sub: `${fmt(o.amount)} · ${o.stage}`,
          body: `No meaningful touch in ${o.lastTouchDays} days.${todayByAccount.has(o.account) ? ` Meeting today at ${todayByAccount.get(o.account)!.time}.` : " No meeting scheduled."}`,
          flag: `${o.lastTouchDays}d quiet`,
        })),
      },
      {
        kind: "kanban",
        title: `Deals ≥ ${fmt(minAmount)} by stage`,
        lanes: stages.map((s) => ({
          name: s,
          cards: keep.filter((o) => o.stage === s).map((o) => ({
            title: o.account,
            sub: `${fmt(o.amount)} · closes ${o.closeDate}`,
            flag: isQuiet(o) ? `${o.lastTouchDays}d quiet` : undefined,
          })),
        })),
      },
    ],
  };
}

export function meetingPrepSpec(): WorkspaceSpec {
  const oppById = new Map(opportunities.map((o) => [o.id, o]));
  return {
    id: "meeting-prep",
    title: "Meeting prep",
    subtitle: `${meetings.length} meetings today · research, history, and talking points`,
    blocks: [
      {
        kind: "metrics",
        items: [
          { label: "Meetings today", value: String(meetings.length) },
          { label: "Pipeline in play", value: fmt(meetings.reduce((s, m) => s + (oppById.get(m.relatedOpportunity ?? "")?.amount ?? 0), 0)) },
          { label: "Quiet accounts", value: String(meetings.filter((m) => { const o = oppById.get(m.relatedOpportunity ?? ""); return o && isQuiet(o); }).length) },
        ],
      },
      {
        kind: "cards",
        title: "Today's meetings — briefs",
        cards: meetings.map((m: Meeting) => {
          const o = oppById.get(m.relatedOpportunity ?? "");
          return {
            title: `${m.time} — ${m.title}`,
            sub: `${m.account}${o ? ` · ${fmt(o.amount)} ${o.stage}` : ""} · ${m.attendees.join(", ")}`,
            body: `Last interaction: ${m.lastInteraction}\n${m.notes}`,
            flag: o && isQuiet(o) ? "quiet" : undefined,
          };
        }),
      },
      {
        kind: "list",
        title: "Suggested prep tasks",
        items: [
          { title: "Pull liability-cap fallback language for Acme", sub: "Legal approved v2 language last quarter — reuse it" },
          { title: "Globex: load SSO/SCIM + audit-log demo tenant", sub: "Raj asked for this explicitly after demo 1" },
          { title: "Northwind: draft re-engagement angle before the call", sub: "Two unanswered follow-ups — lead with new value, not the proposal" },
          { title: "Umbrella: build discovery question set", sub: "First real conversation — qualify budget and decision process" },
        ],
      },
    ],
  };
}

export function defaultSpec(): WorkspaceSpec {
  return {
    id: "home",
    title: "Good morning",
    subtitle: "Tell me how you want to work — I'll assemble the surface.",
    blocks: [
      {
        kind: "metrics",
        items: [
          { label: "Meetings today", value: String(meetings.length) },
          { label: "Open pipeline", value: fmt(opportunities.reduce((s, o) => s + o.amount, 0)) },
          { label: "Deals going quiet", value: String(opportunities.filter(isQuiet).length) },
        ],
      },
      {
        kind: "list",
        title: "Try saying",
        items: [
          { title: "Help me manage my pipeline", sub: "assembles a pipeline workspace" },
          { title: "I don't care about deals under $25K — show me deals going quiet, today's meetings on top", sub: "reshapes the workspace around your priorities" },
          { title: "Help me prepare for my meetings", sub: "builds a meeting-prep surface from calendar, CRM, and history" },
        ],
      },
    ],
  };
}
