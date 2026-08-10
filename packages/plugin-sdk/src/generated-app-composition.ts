/** Low-level, bounded, native composition vocabulary shared by generated tools. */
export type NativeViewLeaf = {
  id: string;
  type: "view";
  viewId: string;
  chrome?: "card" | "subtle" | "none";
  density?: "compact" | "comfortable" | "spacious";
  emphasis?: "primary" | "normal" | "quiet";
  span?: { base?: number; md?: number; lg?: number };
};

export type NativeCompositionNode =
  | NativeViewLeaf
  | {
      id: string;
      type: "surface";
      surface: "attention" | "operator" | "drafts";
      chrome?: "card" | "subtle" | "none";
      density?: "compact" | "comfortable" | "spacious";
      emphasis?: "primary" | "normal" | "quiet";
      span?: { base?: number; md?: number; lg?: number };
    }
  | {
      id: string;
      type: "stack" | "grid" | "split" | "section";
      title?: string;
      description?: string;
      gap?: "none" | "compact" | "normal" | "spacious";
      columns?: number;
      ratio?: "1:1" | "1:2" | "2:1" | "1:3" | "3:1";
      tone?: "plain" | "subtle" | "accent";
      children: NativeCompositionNode[];
    }
  | {
      id: string;
      type: "tabs";
      tabs: Array<{ id: string; label: string; child: NativeCompositionNode }>;
    };

export function validateGeneratedAppComposition(
  composition: NativeCompositionNode,
  availableViewIds: ReadonlySet<string>,
): boolean {
  let nodes = 0;
  const ids = new Set<string>();
  function visit(node: NativeCompositionNode, depth: number): boolean {
    nodes += 1;
    if (nodes > 64 || depth > 6 || ids.has(node.id)) return false;
    ids.add(node.id);
    if (node.type === "surface") return true;
    if (node.type === "view") return availableViewIds.has(node.viewId);
    if (node.type === "tabs") {
      return (
        node.tabs.length > 0 &&
        node.tabs.length <= 8 &&
        node.tabs.every((tab) => visit(tab.child, depth + 1))
      );
    }
    if (node.children.length === 0 || node.children.length > 24) return false;
    if (
      node.type === "grid" &&
      (!node.columns || node.columns < 1 || node.columns > 12)
    )
      return false;
    if (node.type === "split" && node.children.length !== 2) return false;
    return node.children.every((child) => visit(child, depth + 1));
  }
  return visit(composition, 0);
}
