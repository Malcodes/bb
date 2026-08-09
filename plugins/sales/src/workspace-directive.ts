/** Canonical, parser-safe reference emitted by workspace creation tools. */
export function workspaceDirective(workspaceId: string): string {
  return `::sales-workspace{id=${JSON.stringify(workspaceId)}}`;
}

/**
 * Accept the canonical short key plus prior public spellings so persisted
 * assistant messages keep rendering across the contract migration.
 */
export function workspaceIdFromDirective(
  attributes: Readonly<Record<string, string>>,
): string {
  return (
    attributes.id ??
    attributes.workspaceId ??
    attributes.workspaceid ??
    attributes["workspace-id"] ??
    ""
  ).trim();
}
