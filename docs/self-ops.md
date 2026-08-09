# Self-ops: BB's self-maintaining and self-improving layer

The `selfops` builtin plugin runs BB's observe → diagnose → hypothesize → change → test → measure → keep/revert loop over BB's own operation.

## Evidence

Agents and adapters contribute evidence with `selfops_observe`: agent traces, tool calls, model/provider usage (task class, tier, cost, latency), errors, run outcomes, human corrections, approval decisions, schedule heartbeats, surface usage, and test results. Evidence is bounded, credential-free, and deduplicated by fingerprint.

## Maintainer

Diagnoses oversized context, failing scheduled runs, bad retry loops, redundant tool calls, broken connectors, duplicate work, and latency regressions. Routine safe repairs (schedule backoff, retry caps) apply autonomously and are re-verified by later observation. Anything touching permissions, secrets, destructive migrations, external-action safety, or trust boundaries is always approval-required and is never adopted silently.

## Optimizer

Learns from approvals/rejections/dismissals, outcomes, and repeated prompts. Proposes bounded changes (prompt compaction, dedup policy, model routing, surface evolution, config adjustment). Every tested change must beat the adoption gate on held-out/historical tasks: reliability at or above floor (≥0.95, no regression beyond 0.02) AND a strict improvement in its target metric. Cheaper-but-less-reliable is always reverted. Optimization targets human capability amplification and goal attainment — never merely fewer tokens or more automation.

## Model/provider efficiency

Adopted model-routing experiments update a learned cheapest-reliable routing table per task class (e.g. `model-routing:agent:email-triage → cheap` at measured reliability). Over time this becomes BB's evidence base for routing each class of work to the cheapest reliable model/provider.

## Human surface

Only approval-required changes and unrepairable escalations reach the human (`selfops_read_brief` / `selfops_resolve_attention`, plus the 10-minute background loop's log). Approving adopts exactly the bounded proposal that was shown — nothing else.
