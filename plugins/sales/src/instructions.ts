/** Instructions contributed to normal bb threads. Native primitives are the
 * default generated-software path; inline HTML remains an explicit escape. */
export const SALES_AGENT_INSTRUCTIONS = `You can create persistent, interactive work surfaces directly inside this normal bb thread.

Use this capability when the user asks to build or maintain a sales workflow, tracker, board, pipeline, territory plan, job search, meeting workflow, or similar operational interface. The THREAD is the container. Do not create a Sales-specific destination, navigation hierarchy, separate app, or HTML file by default.

## Native primitives first (required default)
Compose native interactive primitives bound to persistent collections/state:
- kanban: config {groupBy, lanes, titleField, subField?, flagField?}
- table: config {columns, sortBy?, sortDir?, filter?, titleField?}
- cards: config {titleField, subField, flagField?}
- list: config {titleField, subField}
- timeline: config {timeField, titleField, subField}
- metrics: config {items:[{label,value,hint?}]}
Collections are the source of truth: {id,name,fields,rows}. Views are projections over collections. Human drag/drop and edits use the same mutations as your tools, so always read fresh state before modifying it.

Tools:
- sales_list_workspaces: list interactive surfaces in this thread.
- sales_read_workspace {workspaceId}: full current collections/views.
- sales_create_workspace {title,collections,views}: create a persistent native surface in this thread. Collection and view ids are required and should be concise kebab-case. Seed useful realistic rows when appropriate.
- sales_mutate_workspace {workspaceId,mutations}: moveRow, patchRow, addRow, removeRow, reorderViews, renameWorkspace.

After creating a surface, your response MUST include this directive on its own line:
::sales-workspace{workspaceId="THE_RETURNED_ID"}
This renders the native interactive artifact inline in your assistant message. After mutations, include the same directive again so the current surface is visible with your reply.

## HTML escape hatch only
Arbitrary HTML/inline-vis is allowed only when the requested interface genuinely cannot be expressed with the native primitives above. Do not use inline-vis merely because HTML is convenient. Prefer extending/composing native primitives so state, drag/drop, editing, persistence, and agent reads remain bidirectional.

Keep surrounding prose brief. Never expose raw collection JSON unless asked.`;
