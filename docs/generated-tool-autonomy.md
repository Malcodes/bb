# Capability amplification north star

BB exists to make one human extraordinarily capable. Success is measured by the additional objectives, context, judgment quality, and operational scope a person can command—not by counts of automated tasks. Agents should remove coordination and clerical load so the human can spend more time on judgment, creativity, relationships, strategy, and consequential decisions. Sales/GTM is the first proving domain, not the architecture boundary.

## Generated-tool autonomy architecture

Generated workspaces are human-facing projections of agent-maintained state. They do not own provider credentials or embed provider integrations.

## Shared source plane

A generated tool stores only connector bindings: source kind, label, resource reference, and granted scopes. Email, calendar, meeting transcripts, contacts, files, web, and future providers remain shared BB capabilities. Connector events normalize into evidence signals with stable source fingerprints; operators reconcile those signals idempotently into maintained state.

## Four permission boundaries

1. **Observe** — which connector bindings an operator may read. Observation grants no write authority.
2. **Internal state** — automatically reconcile workspace state, or recommend changes only.
3. **Prepare external actions** — draft an external action, recommend a draft, or disable preparation.
4. **Execute consequential external actions** — disabled or individually human-approved. A broad source grant or internal-write grant never crosses this boundary.

## Runtime

A durable scheduler sweeps enabled generated tools and starts one hidden operator thread per due workspace. It reuses the workspace's project/environment and available shared connectors. Runs, normalized signals, recommendations, exceptions, provenance, and approval decisions persist with the workspace. Realtime invalidation updates every projection. Hidden workers never become sidebar clutter.

Generated-tool implementations adapt their domain state to this shared contract; they must not hard-code provider credentials or duplicate email/calendar/web integrations.

## Three maintenance layers

1. **Operational state** — agents may observe and reconcile evidence according to internal-state permissions.
2. **Generated-tool definition/presentation** — agents may evolve host-safe module definitions according to an independent `evolvePresentation` grant: add/update/hide/remove/reorder/resize modules, change projections and density, consolidate redundant modules, and add native decision controls. These operations never delete collections merely to simplify the UI.
3. **BB platform/runtime** — stable infrastructure outside generated-tool self-improvement authority. Operator agents cannot use presentation evolution to edit host code, plugin runtime, connectors, permission enforcement, or platform configuration.

The default human projection should contain information needed to understand, decide, or act. Evidence, ranked intermediate outputs, and operator activity may remain available to agents without being rendered. A decision module must provide the bounded interaction required to resolve it, rather than merely describe the decision.

## Low-level native composition

Generated tools are not restricted to one high-level page template. The shared SDK exports a bounded recursive native composition tree:

- state-bound view leaves and BB-owned attention/operator surfaces;
- stack and responsive grid containers;
- asymmetric two-pane splits;
- semantic sections;
- accessible tabs;
- per-leaf chrome, density, emphasis, and responsive span controls.

Composition is presentation state: persistent, agent-editable, schema-validated, responsive, and independent of operational collections. The safety envelope allows at most 64 nodes, six levels, 24 children per container, eight tabs, and only references visible registered views. Existing workspaces without a composition keep the sortable module stack, so this is additive rather than a migration cliff.

Agents should derive composition from the actual information architecture. Relationship work, pipelines, job searches, project command centers, and research should not converge visually unless their hierarchy and interaction needs genuinely match. Arbitrary HTML remains an escape hatch only when this native vocabulary cannot express a genuinely novel interface.

## Capability adapters, not application replicas

BB does not replace every external product with another application. Email, calendar, CRM, files, meeting systems, browsers, payment systems, and future products are capability adapters:

- **sources** emit evidence and real-world events;
- **infrastructure** supports memory, identity, scheduling, research, and computation;
- **action channels** execute a narrowly described side effect after policy permits it.

Their full databases and clerical interfaces do not need to be projected to the human. The autonomous operating state is goals, canonical entity memory, opportunities, evidence, actions, and outcomes. The attention projection contains only material understanding, decisions, exceptions, approvals, and high-value actions.

## Persistent operating loop

1. Maintain durable goals with explicit success criteria and evaluated progress.
2. Ingest and deduplicate real-world signals from granted source adapters.
3. Reconcile canonical entities and confidence-scored facts with provenance.
4. Discover, research, score, prioritize, and advance opportunities.
5. Perform permitted internal work without clerical prompts.
6. Prepare a consequential action as an idempotent proposal.
7. Wait for explicit human approval; a connector grant or conversation is not approval.
8. Atomically claim the approved action once before calling an action channel.
9. Persist the authoritative result, evidence, and any failure.
10. Evaluate goal impact and schedule the next follow-up.

Approved actions bypass normal research cadence so they are picked up promptly. Claims transition `approved → executing`; duplicate claims are rejected. Outcome recording requires `executing` state and settles the action as `succeeded` or `failed` with an evaluation record.

## Gmail and Google Calendar adapters

The first concrete source/action adapters use Gmail history IDs and Calendar sync tokens for incremental ingestion. Expired cursors recover through bounded full synchronization. Provider credentials remain secret connector settings and never enter workspace state, signals, prompts, or action payloads.

Normalized Gmail evidence includes complete thread history, participants, labels/importance, canonical person/company references, commitments, response-needed detection, and unanswered commitment detection. Calendar evidence includes organizers/attendees, response state, upcoming timing, location/context, extracted commitments, meeting-prep needs, and scheduling decisions.

Routine detection is not automatically a human notification. It wakes the hidden operator so it can reconcile entity/workstream memory, draft replies using full history, prepare concise meeting briefs, and decide whether anything truly needs attention. The human projection receives only unresolved exceptions, real scheduling decisions, send/update approvals, material changed context, and outcomes.

Concrete action types are:

- `gmail.send-reply`
- `google-calendar.update-event`

Both require a bounded payload, an enabled `google-work` action-channel binding, an idempotent proposal, explicit approval, and an atomic claim before the API transport is callable. Success/failure and provider evidence are recorded as outcomes.
