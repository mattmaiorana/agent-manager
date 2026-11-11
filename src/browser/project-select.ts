import type { ProjectGroup } from "../plugin/tickets.js";

export function fillProjectSelect(select: HTMLSelectElement, groups: ProjectGroup[], value: string): void {
  for (const g of groups) {
    const parent: HTMLElement = g.label ? select.createEl("optgroup", { attr: { label: g.label } }) : select;
    for (const o of g.options) {
      const opt = parent.createEl("option", { text: o.text, value: o.value });
      if (o.value === value) opt.selected = true;
    }
  }
}
