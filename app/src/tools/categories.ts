export const TOOL_CATEGORIES = [
  "organize",
  "optimize",
  "convert",
  "edit",
  "security",
  "intelligence",
] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Home filter chips (docs/04_UI_UX.md §2.1). "workflows" is a chip, not a tool category. */
export type CategoryFilter = "all" | "workflows" | ToolCategory;

export interface CategoryMeta {
  label: string;
  /** Tailwind classes for the tool card icon tile (token-based, light + dark). */
  iconClass: string;
}

export const CATEGORY_META: Record<ToolCategory, CategoryMeta> = {
  organize: { label: "Organize", iconClass: "bg-cat-organize/15 text-cat-organize" },
  optimize: { label: "Optimize", iconClass: "bg-cat-optimize/15 text-cat-optimize" },
  convert: { label: "Convert", iconClass: "bg-cat-convert/15 text-cat-convert" },
  edit: { label: "Edit", iconClass: "bg-cat-edit/15 text-cat-edit" },
  security: { label: "Security", iconClass: "bg-cat-security/15 text-cat-security" },
  intelligence: {
    label: "Intelligence",
    iconClass: "bg-cat-intelligence/15 text-cat-intelligence",
  },
};

export function filterChips(intelligenceEnabled: boolean): CategoryFilter[] {
  const chips: CategoryFilter[] = [
    "all",
    "workflows",
    "organize",
    "optimize",
    "convert",
    "edit",
    "security",
  ];
  if (intelligenceEnabled) chips.push("intelligence");
  return chips;
}

export function chipLabel(chip: CategoryFilter): string {
  if (chip === "all") return "All";
  if (chip === "workflows") return "Workflows";
  return CATEGORY_META[chip].label;
}
