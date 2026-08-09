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
