/**
 * Durable product guidance for any plugin or core capability that creates a
 * BB-generated workspace. Exported by the SDK so generated-app implementations
 * contribute one shared philosophy instead of maintaining product-specific
 * copies.
 */
export const GENERATED_APP_AGENT_PRINCIPLES = `## Generated-app operating principle: the human is the orchestrator, not the operator

Build generated interfaces and workflows so agents perform as much ongoing operational work as reasonably possible. The human should primarily set goals, approve important decisions, correct direction, and inspect outcomes—not manually maintain fields, move records, fill forms, update statuses, or babysit pipelines.

When designing or modifying any BB-generated app:
- Prefer agent-maintained state over human data entry.
- Prefer proactive monitoring, enrichment, research, classification, prioritization, follow-up preparation, and recommendations over passive record storage.
- Treat Kanban boards, dashboards, metrics, queues, tables, and lists as human oversight surfaces, not the primary mechanism for maintaining truth.
- If data can reasonably be inferred, researched, synchronized, or updated by an agent, do that instead of asking the human to enter it.
- Surface exceptions, decisions, approvals, uncertainty, and high-value actions to the human.
- Keep supporting evidence, provenance, history, and underlying structured data available to agents even when hidden from the human UI.
- Optimize the rendered app around: "What does the human need to see or decide next?"
- Avoid traditional CRM ergonomics where maintaining the system becomes work in itself.
- Before adding any feature, ask internally: "Can an agent own this task instead?" If yes, design it agent-first.

The product-level measure of success is human capability amplification, not automation volume: increase the number and ambition of objectives one person can pursue, the situational awareness they can retain, the quality and speed of their decisions, and the operational surface area they can govern. Automation is useful only insofar as it creates that leverage.

Sales/GTM is one proving domain, not the platform boundary. These principles are domain-independent. BB is not trying to replace every application with another application: it absorbs external products as capability adapters—data sources, infrastructure, and action channels agents use toward human goals. Do not recreate a database, dashboard, workflow editor, CRM, inbox, or calendar merely because structured state or an integration exists. Keep that state agent-readable under the hood and project only goals, material understanding, decisions, exceptions, approvals, high-value actions, and outcomes where human attention creates value.

A generated app is therefore an agent-operated system with a human oversight and decision surface—not a passive database that transfers clerical work to the user.`;
