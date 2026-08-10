/**
 * DRAFTS — a reusable native generated-tool surface for prepared
 * consequential external actions awaiting a human decision.
 *
 * Live-bound to the authoritative autonomy state (externalActions). Every
 * draft shows full content + provenance; Approve / Reject / Comment go
 * through the same approval-gated execution path as before — this surface
 * never executes anything itself. Comment returns the draft to the
 * responsible agent for revision; a revision invalidates prior approval.
 */
import { useState } from "react";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { safeIcon } from "./generated-app.js";

export interface DraftAction {
  id: string;
  title: string;
  actionType: string;
  target: string;
  payloadSummary: string;
  payload: Record<string, string>;
  rationale: string;
  evidence: string[];
  status: string;
  revision?: number;
  revisions?: Array<{
    revision: number;
    payloadSummary: string;
    rationale: string;
    revisedBy: "agent" | "human";
    comment?: string;
    createdAt: string;
  }>;
  comments?: Array<{ text: string; at: string; onRevision: number }>;
  createdAt: string;
  updatedAt?: string;
  approvedAt?: string;
}

function relativeTime(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  return rtf.format(-Math.round(hours / 24), "day");
}

function actionTypeLabel(type: string): string {
  if (type === "gmail.send-reply") return "Email reply";
  if (type === "google-calendar.update-event") return "Calendar change";
  return type;
}

/** Best-effort recipient extraction from an action payload. */
function recipientsOf(action: DraftAction): string {
  const to = action.payload.to;
  if (to) {
    try {
      const parsed = JSON.parse(to) as string[];
      if (Array.isArray(parsed)) return parsed.join(", ");
    } catch {
      return to;
    }
  }
  return action.target;
}

function subjectOf(action: DraftAction): string {
  return action.payload.subject ?? action.title;
}

function bodyOf(action: DraftAction): string {
  return action.payload.body ?? action.payloadSummary;
}

export function DraftsSurface({
  actions,
  onDecide,
  onComment,
}: {
  /** Prepared consequential actions awaiting the human (status proposed). */
  actions: DraftAction[];
  onDecide(actionId: string, decision: "approved" | "rejected"): void;
  onComment(actionId: string, comment: string): void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [commentingId, setCommentingId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState("");
  const [historyId, setHistoryId] = useState<string | null>(null);

  if (actions.length === 0) {
    return (
      <div className="px-3 py-4 text-[11px] text-muted-foreground">
        No drafts waiting for you.
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/40" data-drafts-surface>
      {actions.map((action) => {
        const expanded = expandedId === action.id;
        const revision = action.revision ?? 1;
        const comments = action.comments ?? [];
        return (
          <section key={action.id} className="px-3 py-2.5">
            <div className="flex items-start gap-2.5">
              <Icon
                name={safeIcon(
                  action.actionType.startsWith("gmail") ? "Mail01" : "CalendarCheck01",
                  "FileText",
                )}
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-xs font-medium">
                    {action.title}
                  </span>
                  <Badge variant="outline" className="h-4 px-1 text-[9px]">
                    {actionTypeLabel(action.actionType)}
                  </Badge>
                  {revision > 1 ? (
                    <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                      rev {revision}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  To: {recipientsOf(action)} · {relativeTime(action.updatedAt ?? action.createdAt)}
                </p>
                {/* Full draft context */}
                <div className="mt-1.5 rounded-md border border-border/50 bg-muted/30 px-2.5 py-2">
                  <div className="text-[11px] font-medium">
                    {subjectOf(action)}
                  </div>
                  <p
                    className={cn(
                      "mt-1 whitespace-pre-wrap text-[11px] leading-4 text-foreground/85",
                      !expanded && "line-clamp-4",
                    )}
                  >
                    {bodyOf(action)}
                  </p>
                  <div className="mt-1.5 border-t border-border/40 pt-1.5">
                    <p className="text-[10px] leading-4 text-muted-foreground">
                      <span className="font-medium">Why:</span> {action.rationale}
                    </p>
                    {action.evidence.length > 0 ? (
                      <p className="text-[10px] leading-4 text-muted-foreground/80">
                        <span className="font-medium">Source:</span>{" "}
                        {action.evidence[0]}
                      </p>
                    ) : null}
                  </div>
                </div>
                {/* Comment thread */}
                {comments.length > 0 ? (
                  <div className="mt-1.5 space-y-1">
                    {comments.slice(-2).map((comment, index) => (
                      <p
                        key={index}
                        className="rounded bg-amber-500/5 px-2 py-1 text-[10px] leading-4 text-amber-700 dark:text-amber-300"
                      >
                        You (rev {comment.onRevision}): {comment.text}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => onDecide(action.id, "approved")}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px]"
                    onClick={() => onDecide(action.id, "rejected")}
                  >
                    Reject
                  </Button>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      setCommentingId(
                        commentingId === action.id ? null : action.id,
                      );
                      setCommentText("");
                    }}
                  >
                    Comment
                  </Button>
                  {(action.revisions?.length ?? 0) > 1 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[10px]"
                      onClick={() =>
                        setHistoryId(historyId === action.id ? null : action.id)
                      }
                    >
                      History
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
            {commentingId === action.id ? (
              <div className="mt-2 flex flex-col gap-1.5 pl-6">
                <textarea
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  placeholder="What should change? e.g. “Shorter, warmer, don’t mention pricing yet.”"
                  className="min-h-14 w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-[11px] outline-none focus:border-ring"
                />
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setCommentingId(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={!commentText.trim()}
                    onClick={() => {
                      onComment(action.id, commentText.trim());
                      setCommentingId(null);
                      setCommentText("");
                    }}
                  >
                    Send for revision
                  </Button>
                </div>
              </div>
            ) : null}
            {historyId === action.id ? (
              <ol className="mt-2 space-y-1 border-l border-border/50 pl-3">
                {(action.revisions ?? [])
                  .slice()
                  .reverse()
                  .map((rev) => (
                    <li key={rev.revision} className="text-[10px] leading-4 text-muted-foreground">
                      <span className="font-medium">rev {rev.revision}</span> ·{" "}
                      {relativeTime(rev.createdAt)} — {rev.payloadSummary}
                      {rev.comment ? (
                        <span className="text-amber-700 dark:text-amber-300">
                          {" "}
                          (responding to: “{rev.comment.slice(0, 80)}”)
                        </span>
                      ) : null}
                    </li>
                  ))}
              </ol>
            ) : null}
            <button
              type="button"
              className="mt-1 pl-6 text-[10px] text-muted-foreground/70 hover:text-foreground"
              onClick={() => setExpandedId(expanded ? null : action.id)}
            >
              {expanded ? "Show less" : "Show full draft"}
            </button>
          </section>
        );
      })}
    </div>
  );
}
