import { useMemo, type ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@bb/shared-ui/avatar";
import { Badge } from "@bb/shared-ui/badge";
import { Button } from "@bb/shared-ui/button";
import { ICON_NAMES, Icon, type IconName } from "@bb/shared-ui/icon";
import { Input } from "@bb/shared-ui/input";
import { cn } from "@bb/shared-ui/lib/utils";
import type { Collection, FieldMetadata, Row, RowValue } from "./model.js";

export type SemanticTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

const iconNames = new Set<string>(ICON_NAMES);
export function safeIcon(
  name: string | undefined,
  fallback: IconName = "Circle",
): IconName {
  return name && iconNames.has(name) ? (name as IconName) : fallback;
}

const toneClasses: Record<SemanticTone, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  info: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  success:
    "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning:
    "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300",
};

export function valueText(value: RowValue | undefined): string {
  return value == null ? "" : String(value);
}

export function fieldLabel(field: string, meta?: FieldMetadata): string {
  if (meta?.label) return meta.label;
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

export function SemanticBadge({
  value,
  tone = "neutral",
  icon,
}: {
  value: string;
  tone?: SemanticTone;
  icon?: string;
}) {
  if (!value) return null;
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 gap-1 rounded-md px-1.5 text-[10px] font-medium leading-none shadow-none",
        toneClasses[tone],
      )}
    >
      {icon ? <Icon name={safeIcon(icon)} className="size-3" /> : null}
      {value}
    </Badge>
  );
}

function initials(value: string): string {
  return (
    value
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export function EntityAvatar({
  image,
  fallback,
  shape = "rounded",
  size = "md",
}: {
  image?: string;
  fallback: string;
  shape?: "circle" | "rounded";
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass =
    size === "sm" ? "size-7" : size === "lg" ? "size-10" : "size-8";
  return (
    <Avatar
      className={cn(
        sizeClass,
        "shrink-0 border bg-background shadow-[0_1px_2px_hsl(var(--foreground)/0.04)]",
        shape === "rounded" && "rounded-md [&>img]:rounded-md",
      )}
    >
      {image ? <AvatarImage src={image} alt="" /> : null}
      <AvatarFallback
        className={cn(
          "bg-muted text-[10px] font-semibold tracking-tight text-muted-foreground",
          shape === "rounded" && "rounded-md",
        )}
      >
        {initials(fallback)}
      </AvatarFallback>
    </Avatar>
  );
}

export function MetadataItem({
  icon,
  children,
}: {
  icon?: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      {icon ? (
        <Icon name={safeIcon(icon)} className="size-3 shrink-0 opacity-75" />
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function GeneratedAppToolbar({
  query,
  onQueryChange,
  placeholder = "Search…",
  filters,
  trailing,
}: {
  query: string;
  onQueryChange(value: string): void;
  placeholder?: string;
  filters?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-background/95 px-3 py-2 supports-[backdrop-filter]:backdrop-blur-sm">
      <div className="relative w-full sm:w-64">
        <Icon
          name="Search"
          className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
          className="h-8 rounded-md border-border/80 bg-muted/20 pl-8 text-xs shadow-none focus-visible:bg-background"
        />
      </div>
      {filters}
      <div className="ml-auto flex items-center gap-2">{trailing}</div>
    </div>
  );
}

export function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      className="h-7 rounded-md px-2 text-[11px] font-medium"
    >
      <Icon name="SlidersHorizontal" className="mr-1 size-3" />
      {label}
    </Button>
  );
}

export function FieldControl({
  field,
  meta,
  value,
  onChange,
}: {
  field: string;
  meta?: FieldMetadata;
  value: string;
  onChange(value: string): void;
}) {
  const id = `generated-field-${field}`;
  if (meta?.type === "multiline") {
    return (
      <label htmlFor={id} className="grid gap-1.5 text-xs font-medium">
        <span className="text-muted-foreground">{fieldLabel(field, meta)}</span>
        <textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={meta.placeholder}
          rows={4}
          className="min-h-24 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring"
        />
      </label>
    );
  }
  if (meta?.type === "select" && meta.options?.length) {
    return (
      <label htmlFor={id} className="grid gap-1.5 text-xs font-medium">
        <span className="text-muted-foreground">{fieldLabel(field, meta)}</span>
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
        >
          <option value="">Select…</option>
          {meta.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const type =
    meta?.type === "date"
      ? "date"
      : meta?.type === "datetime"
        ? "datetime-local"
        : meta?.type === "number" || meta?.type === "currency"
          ? "number"
          : meta?.type === "email"
            ? "email"
            : meta?.type === "url" || meta?.type === "image"
              ? "url"
              : "text";
  return (
    <label htmlFor={id} className="grid gap-1.5 text-xs font-medium">
      <span className="text-muted-foreground">{fieldLabel(field, meta)}</span>
      <Input
        id={id}
        type={type}
        value={value}
        required={meta?.required}
        placeholder={meta?.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 text-sm"
      />
    </label>
  );
}

export function resolveTone(
  collection: Collection,
  field: string,
  value: string,
  explicit?: SemanticTone,
  toneMap?: Partial<Record<string, SemanticTone>>,
): SemanticTone {
  return (
    toneMap?.[value] ??
    collection.fieldMeta?.[field]?.toneMap?.[value] ??
    explicit ??
    "neutral"
  );
}

export function recordDraft(
  collection: Collection,
  row: Row | null,
  fields: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [field, row ? valueText(row[field]) : ""]),
  );
}

export function useVisibleFields(
  collection: Collection,
  configured: readonly string[] | undefined,
  fallbackCount: number,
): string[] {
  return useMemo(
    () =>
      configured?.filter((field) => collection.fields.includes(field)) ??
      collection.fields.slice(0, fallbackCount),
    [collection.fields, configured, fallbackCount],
  );
}
