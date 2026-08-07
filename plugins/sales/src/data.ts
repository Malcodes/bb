export type Opportunity = {
  id: string;
  name: string;
  account: string;
  amount: number;
  stage: "Discovery" | "Qualification" | "Demo" | "Proposal" | "Negotiation" | "Closed Won";
  closeDate: string;
  lastTouchDays: number;
  owner: string;
};

export type Meeting = {
  id: string;
  time: string;
  title: string;
  account: string;
  attendees: string[];
  relatedOpportunity?: string;
  lastInteraction: string;
  notes: string;
};

export const opportunities: Opportunity[] = [
  { id: "o1", name: "Acme Corp — Platform expansion", account: "Acme Corp", amount: 185000, stage: "Negotiation", closeDate: "Aug 29", lastTouchDays: 2, owner: "You" },
  { id: "o2", name: "Northwind — New logo", account: "Northwind Traders", amount: 96000, stage: "Proposal", closeDate: "Sep 12", lastTouchDays: 9, owner: "You" },
  { id: "o3", name: "Globex — Renewal + seats", account: "Globex", amount: 142000, stage: "Demo", closeDate: "Sep 5", lastTouchDays: 12, owner: "You" },
  { id: "o4", name: "Initech — Pilot", account: "Initech", amount: 18000, stage: "Discovery", closeDate: "Oct 1", lastTouchDays: 4, owner: "You" },
  { id: "o5", name: "Umbrella — Enterprise rollout", account: "Umbrella Health", amount: 240000, stage: "Qualification", closeDate: "Oct 18", lastTouchDays: 21, owner: "You" },
  { id: "o6", name: "Stark Industries — Add-on", account: "Stark Industries", amount: 12000, stage: "Proposal", closeDate: "Aug 22", lastTouchDays: 1, owner: "You" },
  { id: "o7", name: "Wayne Enterprises — New logo", account: "Wayne Enterprises", amount: 175000, stage: "Demo", closeDate: "Sep 30", lastTouchDays: 6, owner: "You" },
  { id: "o8", name: "Hooli — Mid-market", account: "Hooli", amount: 64000, stage: "Discovery", closeDate: "Nov 7", lastTouchDays: 15, owner: "You" },
  { id: "o9", name: "Pied Piper — Starter", account: "Pied Piper", amount: 9000, stage: "Qualification", closeDate: "Aug 15", lastTouchDays: 3, owner: "You" },
  { id: "o10", name: "Soylent — Renewal", account: "Soylent Co", amount: 88000, stage: "Negotiation", closeDate: "Aug 31", lastTouchDays: 5, owner: "You" },
];

export const meetings: Meeting[] = [
  { id: "m1", time: "9:30 AM", title: "Acme legal redlines review", account: "Acme Corp", attendees: ["Dana Scully (VP Ops)", "Their counsel"], relatedOpportunity: "o1", lastInteraction: "Tue — sent revised MSA; they flagged liability cap §7.2", notes: "Goal: agree on liability cap language. Dana is champion; CFO joined last call and pushed on price." },
  { id: "m2", time: "11:00 AM", title: "Globex demo — engineering deep dive", account: "Globex", attendees: ["Raj Patel (Dir. Eng)", "2 engineers"], relatedOpportunity: "o3", lastInteraction: "12 days ago — first demo went well; they asked about SSO + audit logs", notes: "Goal: technical win. Prepare SSO/SCIM and audit-log answers. Raj cares about latency benchmarks." },
  { id: "m3", time: "1:15 PM", title: "Northwind proposal walkthrough", account: "Northwind Traders", attendees: ["Alex Kim (Head of Sales)"], relatedOpportunity: "o2", lastInteraction: "9 days ago — sent proposal; no reply to two follow-ups", notes: "Deal is going quiet. Goal: re-engage, confirm budget holder, get timeline commitment." },
  { id: "m4", time: "3:00 PM", title: "Umbrella discovery call", account: "Umbrella Health", attendees: ["Morgan Lee (CRO)", "Sam Ortiz (RevOps)"], relatedOpportunity: "o5", lastInteraction: "3 weeks ago — intro from investor; no discovery yet", notes: "Biggest logo in pipeline. Goal: qualify — pain, budget, timeline, decision process." },
];
