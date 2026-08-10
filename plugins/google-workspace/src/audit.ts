/** Append-only audit trail of connector-driven Gmail/Calendar changes. */
import type { BbPluginApi } from "@bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export interface AuditEntry {
  action: string;
  target: string;
  reason: string;
  outcome: string;
}

export class AuditLog {
  private db: Database;

  constructor(storage: BbPluginApi["storage"]) {
    // Table created by ConnectorStore's migration (shared plugin database).
    this.db = storage.database();
  }

  record(at: string, entry: AuditEntry): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (at, action, target, reason, outcome) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(at, entry.action, entry.target, entry.reason, entry.outcome);
  }

  list(limit = 50): Array<AuditEntry & { at: string }> {
    const rows = this.db
      .prepare(
        `SELECT at, action, target, reason, outcome FROM audit_log ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      at: string;
      action: string;
      target: string;
      reason: string;
      outcome: string;
    }>;
    return rows;
  }
}
