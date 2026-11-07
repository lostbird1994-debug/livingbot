import { describe, expect, it } from "vitest";
import { rehypeReportShape } from "./rehype-report-shape";
import type { HastNode } from "./table-utils";

function h(level: number, text: string): HastNode {
  return {
    type: "element",
    tagName: `h${level}`,
    properties: {},
    children: [{ type: "text", value: text }],
  };
}

function p(text: string): HastNode {
  return {
    type: "element",
    tagName: "p",
    properties: {},
    children: [{ type: "text", value: text }],
  };
}

function root(children: HastNode[]): HastNode {
  return { type: "root", children };
}

function run(tree: HastNode): HastNode {
  rehypeReportShape()(tree);
  return tree;
}

function tagNames(tree: HastNode): (string | undefined)[] {
  return (tree.children ?? []).map((child) => child.tagName);
}

describe("rehypeReportShape", () => {
  it("marks the opening paragraph as the lead only for a multi-block reply", () => {
    const tree = run(root([p("改好了，三个文件都已生效。"), p("第二段"), p("第三段")]));
    expect(tree.children?.[0].properties?.className).toEqual(["rk-lead"]);
  });

  it("leaves a short reply alone", () => {
    const tree = run(root([p("好的，改完了。")]));
    expect(tree.children?.[0].properties?.className).toBeUndefined();
    expect(tree.children?.[0].tagName).toBe("p");
  });

  it("does not box a long opening paragraph", () => {
    const long = "这是一段很长的正文".repeat(30);
    const tree = run(root([p(long), p("第二段"), p("第三段")]));
    expect(tree.children?.[0].properties?.className).toBeUndefined();
  });

  it("folds an evidence section into a closed details", () => {
    const tree = run(root([p("结论"), p("过程"), h(2, "依据"), p("日志片段"), p("文件路径")]));
    const folded = tree.children?.[2];
    expect(folded?.tagName).toBe("details");
    expect(folded?.children?.[0].tagName).toBe("summary");
    expect(folded?.children?.[0].children?.[0].value).toBe("依据");
    expect(folded?.children?.slice(1).map((child) => child.tagName)).toEqual(["p", "p"]);
  });

  it("stops folding at the next heading of the same level", () => {
    const tree = run(root([h(2, "依据"), p("日志"), h(2, "下一步"), p("继续")]));
    expect(tagNames(tree)).toEqual(["details", "h2", "p"]);
  });

  it("keeps a nested heading inside the folded section", () => {
    const tree = run(root([h(2, "证据"), p("日志"), h(3, "子项"), p("细节")]));
    expect(tagNames(tree)).toEqual(["details"]);
    expect(tree.children?.[0].children?.slice(1).map((child) => child.tagName)).toEqual([
      "p",
      "h3",
      "p",
    ]);
  });

  it("does not fold an h1 or an h4 titled as evidence", () => {
    expect(tagNames(run(root([h(1, "依据"), p("日志")])))).toEqual(["h1", "p"]);
    expect(tagNames(run(root([h(4, "依据"), p("日志")])))).toEqual(["h4", "p"]);
  });

  it("leaves an empty evidence heading inline", () => {
    expect(tagNames(run(root([p("结论"), p("过程"), h(2, "依据")])))).toEqual(["p", "p", "h2"]);
  });

  it("never folds more than two sections", () => {
    const tree = run(
      root([
        h(2, "依据"),
        p("a"),
        h(2, "验证"),
        p("b"),
        h(2, "日志"),
        p("c"),
        h(2, "来源"),
        p("d"),
      ]),
    );
    expect(tree.children?.filter((child) => child.tagName === "details")).toHaveLength(2);
    expect(tree.children?.filter((child) => child.tagName === "h2")).toHaveLength(2);
  });

  it("matches English headings too", () => {
    const tree = run(
      root([p("Done."), p("Changed two files."), h(3, "Verification"), p("exit 0")]),
    );
    expect(tree.children?.[2].tagName).toBe("details");
  });

  it("ignores a heading that merely mentions a keyword in a longer phrase", () => {
    const heading = h(2, "为什么这次验证没有覆盖移动端以及后续需要补的内容以及其它说明");
    const tree = run(root([p("结论"), p("过程"), heading, p("说明")]));
    expect(tagNames(tree)).toEqual(["p", "p", "h2", "p"]);
  });

  it("still folds a long heading when the keyword opens it", () => {
    const tree = run(
      root([p("结论"), p("过程"), h(2, "验证：三个文件都已重新构建并通过检查"), p("exit 0")]),
    );
    expect(tree.children?.[2].tagName).toBe("details");
  });
});
