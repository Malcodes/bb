import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import {
  usePluginSlots,
  type PluginSettingsSectionSlot,
} from "@/lib/plugin-slots";
import { PluginSlotMount } from "./PluginSlotMount";
import {
  ResourceDetailPanel,
  ResourceDetailConfigurationSection,
} from "@bb/shared-ui/resource-list";

/**
 * Plugin `settingsSection` slot mounts, rendered on that plugin's canonical
 * Plugins detail page below the host-rendered declarative form.
 * Each section is contained in its own per-plugin error boundary.
 */
export function PluginSettingsSections({ pluginId }: { pluginId: string }) {
  const { settingsSections } = usePluginSlots();
  const sections = settingsSections.filter(
    (section) => section.pluginId === pluginId,
  );
  if (sections.length === 0) return null;
  return <PluginSettingsSectionList sections={sections} />;
}

function PluginSettingsSectionList({
  sections,
}: {
  sections: readonly PluginSettingsSectionSlot[];
}) {
  const location = useLocation();

  useEffect(() => {
    if (location.hash.length <= 1) return;
    let sectionId: string;
    try {
      sectionId = decodeURIComponent(location.hash.slice(1));
    } catch {
      return;
    }
    if (!sections.some((section) => section.id === sectionId)) return;
    document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
  }, [location.hash, location.key, sections]);

  return (
    <div className="space-y-6" data-testid="plugin-settings-sections">
      {sections.map((section) => (
        <div
          key={`${section.pluginId}/${section.id}/${section.generation}`}
          id={section.id}
          className="scroll-mt-4"
        >
          <ResourceDetailConfigurationSection
            label={section.title ?? "Plugin settings"}
          >
            <ResourceDetailPanel surface="recessed" className="px-3 py-3">
              {section.description !== undefined ? (
                <p className="mb-3 text-xs leading-snug text-subtle-foreground/75">
                  {section.description}
                </p>
              ) : null}
              <PluginSlotMount
                pluginId={section.pluginId}
                slotKind="settingsSection"
                slotId={section.id}
              >
                <section.component />
              </PluginSlotMount>
            </ResourceDetailPanel>
          </ResourceDetailConfigurationSection>
        </div>
      ))}
    </div>
  );
}
