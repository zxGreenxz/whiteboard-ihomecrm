import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import OpenClawKnowledge from "../knowledge/OpenClawKnowledge";
import type { KnowledgeSourceView } from "@/lib/openclaw-zalo/knowledge";

const noop = vi.fn();

const source: KnowledgeSourceView = {
  sourceId: "s1",
  title: "Câu hỏi thường gặp",
  sourceKind: "FAQ",
  sensitivity: "CUSTOMER_SAFE",
  lifecycleState: "DRAFT",
  currentVersion: 3,
  contentHash: "a".repeat(64),
  validationResult: null,
};

const props = {
  sources: [source],
  loading: false,
  canManage: true,
  selectedSourceId: "s1",
  previewMatches: [],
  previewQuery: "",
  busy: false,
  onSelectSource: noop,
  onAct: noop,
  onPreviewQueryChange: noop,
};

const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(OpenClawKnowledge, { ...props, ...overrides }));

/** The opening tag of the button for `action`, so `disabled` can be checked on it. */
function buttonTag(html: string, action: string) {
  const match = html.match(new RegExp(`<button[^>]*data-openclaw-action="knowledge-${action}"[^>]*>`, "u"));
  expect(match, `no button for ${action}`).not.toBeNull();
  return match![0];
}

describe("knowledge screen", () => {
  it("says plainly that a view-only member cannot use this section", () => {
    // Every knowledge RPC requires manage_knowledge, including the LIST, so an empty
    // list would misrepresent a permission problem as "no data".
    const html = render({ canManage: false });
    expect(html).toContain('data-openclaw-knowledge="no-permission"');
    expect(html).not.toContain('data-openclaw-knowledge="sources"');
  });

  it("badges sensitivity and lifecycle per source", () => {
    const html = render();
    expect(html).toContain('data-openclaw-sensitivity="CUSTOMER_SAFE"');
    expect(html).toContain('data-openclaw-lifecycle="DRAFT"');
    expect(html).toContain("v3");
  });

  it("disables publish until the draft carries a validation result", () => {
    expect(buttonTag(render(), "publish")).toContain('disabled=""');
    const validated = render({
      sources: [{ ...source, validationResult: { valid: true } }],
    });
    expect(buttonTag(validated, "publish")).not.toContain('disabled=""');
  });

  it("names WHY an action is unavailable rather than just greying it", () => {
    const html = render();
    expect(html).toContain('data-openclaw-knowledge-blocked="publish:NOT_VALIDATED"');
    expect(html).toContain("Phải kiểm tra bản nháp trước khi xuất bản");
  });

  it("refuses to edit an archived source", () => {
    // The update RPC has no lifecycle guard and would move it back to DRAFT.
    const html = render({ sources: [{ ...source, lifecycleState: "ARCHIVED" }] });
    expect(buttonTag(html, "edit")).toContain('disabled=""');
    expect(html).toContain('data-openclaw-knowledge-blocked="edit:LIFECYCLE"');
  });

  it("states that the draft body cannot be read back, and shows the hash instead", () => {
    // openclaw_get_knowledge_v1 returns contentHash and no content. An empty textarea
    // would read as "this source is empty".
    const html = render();
    expect(html).toContain('data-openclaw-knowledge="content-unavailable"');
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("dán lại toàn bộ nội dung");
  });

  it("blames the missing index, not the operator's search term", () => {
    // Nothing in the migration set writes openclaw_knowledge_chunks, so the preview
    // is always empty; copy blaming the query sends the operator hunting forever.
    const html = render({ sources: [{ ...source, lifecycleState: "PUBLISHED" }] });
    expect(html).toContain('data-openclaw-knowledge-preview-empty="NO_CHUNKS_INGESTED"');
    expect(html).toContain("không phải do từ khoá bạn nhập");
  });

  it("does not offer a sensitivity toggle or a hidden-chunk count it cannot compute", () => {
    // The RPC hardcodes chunk.sensitivity = 'CUSTOMER_SAFE' and omits the key, so
    // both would be fabrications.
    const html = render();
    expect(html).not.toContain("include-internal");
    expect(html).toContain("không trả về mức nhạy cảm của từng đoạn");
  });

  it("does not claim relevance ranking for a substring search", () => {
    expect(render()).toContain("không phải theo độ liên quan");
  });
});
