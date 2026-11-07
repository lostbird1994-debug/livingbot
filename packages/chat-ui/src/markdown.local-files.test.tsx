import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const renderLocalFile = (path: string, label?: string) => (
  <span data-local-file={path}>
    <a href={`file://${path}`}>{label || path.split("/").at(-1)}</a>
    <button type="button">Open folder</button>
  </span>
);
describe("local document links in chat Markdown", () => {
  it.each([
    "MEDIA:/Users/test/财务 报告.docx",
    "`/Users/test/财务 报告.docx`",
    "[报告](</Users/test/财务 报告.docx>)",
  ])("links %s", (text) => {
    const html = renderToStaticMarkup(
      <ChatMarkdown renderLocalFile={renderLocalFile}>{text}</ChatMarkdown>,
    );
    expect(html).toContain('data-local-file="/Users/test/财务 报告.docx"');
    expect(html).toContain("Open folder");
    expect(html).not.toContain("MEDIA:");
  });
  it("does not turn command blocks into clickable file actions", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown renderLocalFile={renderLocalFile}>
        {"```sh\ncat /Users/test/report.docx\n```"}
      </ChatMarkdown>,
    );
    expect(html).not.toContain("data-local-file");
  });
  it("leaves references readable without local file actions", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"MEDIA:/Users/test/report.docx"}</ChatMarkdown>,
    );
    expect(html).toContain("MEDIA:/Users/test/report.docx");
    expect(html).not.toContain("data-local-file");
  });
});
