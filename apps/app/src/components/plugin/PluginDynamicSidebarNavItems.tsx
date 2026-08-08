import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useSidebarReorderDnd } from "@/components/sidebar/useSidebarReorderDnd";
import type {
  PluginSidebarNavItem,
  PluginSidebarNavItemsState,
} from "@bb/plugin-sdk";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import { getPluginPanelRoutePath } from "@/lib/route-paths";
import {
  usePluginSlots,
  type PluginNavPanelSlot,
  type PluginSidebarNavItemsSlot,
} from "@/lib/plugin-slots";
import { PluginIcon } from "./PluginIcon";
import { PluginSlotMount } from "./PluginSlotMount";

/**
 * Host-rendered primary navigation backed by dynamic plugin data providers.
 * Providers publish bounded metadata and mutation callbacks; they never own
 * sidebar markup, routing, active styles, drag behavior, or accessibility.
 */
export function PluginDynamicSidebarNavItems({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { navPanels, sidebarNavItems } = usePluginSlots();
  if (sidebarNavItems.length === 0) return null;
  return (
    <div data-testid="plugin-dynamic-sidebar-nav-items">
      {sidebarNavItems.map((slot) => (
        <DynamicSidebarSection
          key={`${slot.pluginId}/${slot.id}/${slot.generation}`}
          slot={slot}
          panel={
            navPanels.find(
              (panel) =>
                panel.pluginId === slot.pluginId &&
                panel.id === slot.targetPanelId,
            ) ?? null
          }
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}

function DynamicSidebarSection({
  slot,
  panel,
  onNavigate,
}: {
  slot: PluginSidebarNavItemsSlot;
  panel: PluginNavPanelSlot | null;
  onNavigate?: () => void;
}) {
  const [providerState, setProviderState] =
    useState<PluginSidebarNavItemsState>({ items: [] });
  const setState = useCallback((next: PluginSidebarNavItemsState) => {
    setProviderState(next);
  }, []);
  const itemIds = useMemo(
    () => providerState.items.map((item) => item.id),
    [providerState.items],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const from = itemIds.indexOf(String(event.active.id));
      const to = itemIds.indexOf(String(event.over.id));
      if (from < 0 || to < 0) return;
      const ordered = [...itemIds];
      const [moved] = ordered.splice(from, 1);
      if (!moved) return;
      ordered.splice(to, 0, moved);
      void providerState.reorder?.(ordered);
    },
    [itemIds, providerState],
  );

  const { dndContextProps, onClickCapture } = useSidebarReorderDnd({
    onDragEnd: handleDragEnd,
  });

  return (
    <>
      <div className="hidden" aria-hidden>
        <PluginSlotMount
          pluginId={slot.pluginId}
          slotKind="sidebarNavItems"
          slotId={slot.id}
        >
          <slot.provider setState={setState} />
        </PluginSlotMount>
      </div>
      {panel && providerState.items.length > 0 ? (
        <section className="shrink-0 px-2 pb-2" aria-label={slot.title}>
          <div className="px-2 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {slot.title}
          </div>
          <DndContext {...dndContextProps}>
            <SortableContext
              items={itemIds}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-0.5" onClickCapture={onClickCapture}>
                {providerState.items.map((item) => (
                  <DynamicSidebarRow
                    key={item.id}
                    item={item}
                    panel={panel}
                    onNavigate={onNavigate}
                    onRemove={providerState.remove}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </section>
      ) : null}
    </>
  );
}

function DynamicSidebarRow({
  item,
  panel,
  onNavigate,
  onRemove,
}: {
  item: PluginSidebarNavItem;
  panel: PluginNavPanelSlot;
  onNavigate?: () => void;
  onRemove?: PluginSidebarNavItemsState["remove"];
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const sortable = useSortable({ id: item.id });
  const path = getPluginPanelRoutePath({
    pluginId: panel.pluginId,
    path: panel.path,
    subPath: item.subPath,
  });
  const active = location.pathname === path;

  useEffect(() => {
    if (!sortable.isDragging) return;
    document.body.style.cursor = "grabbing";
    return () => {
      document.body.style.cursor = "";
    };
  }, [sortable.isDragging]);

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        "group/row flex h-8 items-center rounded-md text-sm",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/70",
        sortable.isDragging && "z-20 opacity-80 shadow-sm",
      )}
    >
      <button
        type="button"
        {...sortable.attributes}
        {...sortable.listeners}
        onClick={() => {
          // Navigate before mobile-close state changes can tear down the row.
          // The shared sidebar DnD sensors preserve ordinary clicks while
          // requiring a deliberate drag activation distance.
          void navigate(path);
          onNavigate?.();
        }}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 text-left outline-none"
        title={item.title}
      >
        <PluginIcon pluginId={panel.pluginId} icon={item.icon} />
        <span className="truncate">{item.title}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Unpin ${item.title}`}
          title={`Remove ${item.title} from sidebar`}
          className="mr-1 hidden size-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground group-hover/row:flex focus:flex"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void onRemove(item.id);
          }}
        >
          <Icon name="X" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
