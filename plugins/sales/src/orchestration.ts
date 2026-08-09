import type { Collection, Row, View, Workspace } from "./model.js";
import { valueText } from "./generated-app.js";

const TERMINAL =
  /^(won|lost|closed|closed won|closed lost|hired|accepted|rejected|withdrawn|passed)$/i;
const WON = /^(won|closed won|hired|accepted)$/i;
const LOST = /^(lost|closed lost|rejected|withdrawn|passed)$/i;

function findField(
  collection: Collection,
  candidates: RegExp,
): string | undefined {
  return collection.fields.find((field) => candidates.test(field));
}

function nameField(collection: Collection): string {
  return (
    findField(collection, /^(company|name|title|account|opportunity)$/i) ??
    collection.fields[0] ??
    "id"
  );
}

function compactNames(rows: Row[], field: string): string {
  const names = rows.map((row) => valueText(row[field])).filter(Boolean);
  if (names.length === 0) return "the highlighted records";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/**
 * A concise, state-derived brief for the human orchestrator. It names material
 * exceptions and decisions rather than restating the metric strip.
 */
export function deriveAttentionSummary(workspace: Workspace): string {
  const kanban = workspace.views.find(
    (view) => view.visible !== false && view.primitive === "kanban",
  );
  const collection =
    workspace.collections.find(
      (candidate) => candidate.id === kanban?.collectionId,
    ) ?? workspace.collections[0];
  if (!collection || collection.rows.length === 0) {
    return "No active records need attention. The agent can continue monitoring for new exceptions or decisions.";
  }

  const stageField =
    kanban?.config.groupBy ?? findField(collection, /^(stage|status)$/i);
  const priorityField = findField(collection, /^(priority|urgency|risk)$/i);
  const titleField = nameField(collection);
  const activeRows = collection.rows.filter(
    (row) => !stageField || !TERMINAL.test(valueText(row[stageField])),
  );
  const highPriority = priorityField
    ? activeRows.filter((row) =>
        /^(high|urgent|critical|at risk)$/i.test(valueText(row[priorityField])),
      )
    : [];
  const offers = stageField
    ? activeRows.filter((row) =>
        /^(offer|decision|final)$/i.test(valueText(row[stageField])),
      )
    : [];
  const interviewing = stageField
    ? activeRows.filter((row) =>
        /^(interviewing|interview|late stage)$/i.test(
          valueText(row[stageField]),
        ),
      )
    : [];

  const sentences: string[] = [];
  if (highPriority.length > 0) {
    sentences.push(
      `Review ${compactNames(highPriority, titleField)}: ${highPriority.length === 1 ? "it is" : "they are"} marked high priority and still active.`,
    );
  }
  const decisionRows = offers.filter((row) => !highPriority.includes(row));
  if (decisionRows.length > 0 && sentences.length < 2) {
    sentences.push(
      `Decide the next action for ${compactNames(decisionRows, titleField)} in the final stage.`,
    );
  } else if (interviewing.length > 0 && sentences.length < 2) {
    sentences.push(
      `Prepare the next step for ${compactNames(interviewing, titleField)} now in late-stage evaluation.`,
    );
  }
  if (sentences.length === 0) {
    return "No material exceptions are visible right now. Let the agent monitor movement and surface the next decision or risk.";
  }
  return sentences.slice(0, 2).join(" ");
}

/** Keep terminal outcomes visible even when an older generated view omitted them. */
export function resolveKanbanLanes(
  view: View,
  collection: Collection,
  groupBy: string,
): string[] {
  const explicit = view.config.lanes ?? [];
  const fieldOptions = collection.fieldMeta?.[groupBy]?.options ?? [];
  const rowValues = collection.rows
    .map((row) => valueText(row[groupBy]))
    .filter(Boolean);
  const available = Array.from(
    new Set([...explicit, ...fieldOptions, ...rowValues]),
  );
  const lanes = [...explicit];
  for (const value of rowValues) {
    if (!lanes.includes(value)) lanes.push(value);
  }
  const won = available.find((value) => WON.test(value));
  const lost = available.find((value) => LOST.test(value));
  if (won && lost) {
    if (!lanes.includes(won)) lanes.push(won);
    if (!lanes.includes(lost)) lanes.push(lost);
  } else {
    const closed =
      available.find((value) => /^closed$/i.test(value)) ?? "Closed";
    if (!lanes.some((value) => TERMINAL.test(value))) lanes.push(closed);
  }
  return lanes;
}

export function isTerminalStage(value: string): boolean {
  return TERMINAL.test(value);
}
