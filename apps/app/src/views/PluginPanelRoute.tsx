import { useParams } from "react-router-dom";
import { usePluginSlots } from "@/lib/plugin-slots";
import { PluginPanelView } from "./PluginPanelView";
import SplitWorkspaceRoute from "./SplitWorkspaceRoute";

/**
 * Production route boundary for plugin panels.
 *
 * Application panels are owned by this explicit route, so navigating from a
 * thread unmounts SplitWorkspaceRoute/SplitThreadArea instead of reconciling
 * the application into the focused chat pane. Workspace panels retain the
 * existing split-pane behavior.
 */
export default function PluginPanelRoute() {
  const params = useParams<{
    pluginId: string;
    panelPath: string;
    "*": string;
  }>();
  const { navPanels } = usePluginSlots();
  const panel = navPanels.find(
    (candidate) =>
      candidate.pluginId === params.pluginId &&
      candidate.path === params.panelPath,
  );

  if (panel?.surface !== "application") {
    return <SplitWorkspaceRoute />;
  }

  return (
    <PluginPanelView
      pluginId={params.pluginId}
      panelPath={params.panelPath}
      subPath={params["*"] ?? ""}
    />
  );
}
