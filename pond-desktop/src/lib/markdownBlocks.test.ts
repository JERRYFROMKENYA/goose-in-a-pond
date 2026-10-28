import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown, type Block, type Inline } from "./markdownBlocks";

const text = (v: string): Inline => ({ t: "text", v });

describe("inline markdown", () => {
  it("reads bold, italics and code spans", () => {
    expect(parseInline("a **bold** and *em* and `code`")).toEqual([
      text("a "),
      { t: "strong", c: [text("bold")] },
      text(" and "),
      { t: "em", c: [text("em")] },
      text(" and "),
      { t: "code", v: "code" },
    ]);
  });

  it("reads underscores at the start of a word but not inside one", () => {
    expect(parseInline("__bold__")).toEqual([{ t: "strong", c: [text("bold")] }]);
    expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
  });

  it("leaves a lone star as text", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([text("2 * 3 = 6")]);
  });

  it("keeps an escaped mark as the character", () => {
    expect(parseInline("\\*not em\\*")).toEqual([text("*not em*")]);
  });

  it("makes a link of a web or mail address", () => {
    expect(parseInline("[site](https://example.com/a)")).toEqual([
      { t: "link", href: "https://example.com/a", c: [text("site")] },
    ]);
    expect(parseInline("[me](mailto:a@b.co)")).toEqual([{ t: "link", href: "mailto:a@b.co", c: [text("me")] }]);
  });

  it("shows any other kind of link as its text, so nothing can run from it", () => {
    for (const source of ["[x](javascript:alert(1))", "[x](data:text/html,hi)", "[x](/relative)", "[x](file:///etc/passwd)"]) {
      expect(JSON.stringify(parseInline(source)), source).not.toContain('"link"');
    }
  });

  it("shows an image as its description", () => {
    expect(parseInline("![a map](https://example.com/map.png)")).toEqual([text("a map")]);
  });
});

describe("blocks", () => {
  it("reads a heading and a paragraph that runs over two lines", () => {
    const blocks = parseMarkdown("# Title\n\none\ntwo");
    expect(blocks).toEqual([
      { t: "h", level: 1, c: [text("Title")] },
      { t: "p", c: [text("one two")] },
    ]);
  });

  it("drops the closing hashes of a heading", () => {
    expect(parseMarkdown("## Plan ##")).toEqual([{ t: "h", level: 2, c: [text("Plan")] }]);
  });

  it("reads a bulleted list and an ordered one that starts where it says", () => {
    const [bullets, numbers] = parseMarkdown("- one\n- two\n\n3. a\n4. b");
    expect(bullets).toMatchObject({ t: "ul" });
    expect((bullets as Extract<Block, { t: "ul" }>).items).toHaveLength(2);
    expect(numbers).toMatchObject({ t: "ol", start: 3 });
    expect((numbers as Extract<Block, { t: "ol" }>).items).toHaveLength(2);
  });

  it("nests a list under an item", () => {
    const [list] = parseMarkdown("- a\n  - b\n  - c\n- d") as [Extract<Block, { t: "ul" }>];
    expect(list.items).toHaveLength(2);
    const first = list.items[0];
    expect(first[0]).toMatchObject({ t: "p" });
    expect(first[1]).toMatchObject({ t: "ul" });
    expect((first[1] as Extract<Block, { t: "ul" }>).items).toHaveLength(2);
  });

  it("reads a fenced code block as it is written, marks and all", () => {
    expect(parseMarkdown("```js\nconst a = **1**;\n\nb();\n```")).toEqual([
      { t: "code", lang: "js", v: "const a = **1**;\n\nb();" },
    ]);
  });

  it("takes an unclosed fence to the end rather than losing the rest", () => {
    expect(parseMarkdown("```\nstill code")).toEqual([{ t: "code", lang: "", v: "still code" }]);
  });

  it("reads a quote and a rule", () => {
    const blocks = parseMarkdown("> quoted\n> more\n\n---\n\nafter");
    expect(blocks[0]).toEqual({ t: "quote", c: [{ t: "p", c: [text("quoted more")] }] });
    expect(blocks[1]).toEqual({ t: "hr" });
    expect(blocks[2]).toMatchObject({ t: "p" });
  });

  it("starts a list in the middle of a paragraph only at a bullet or a 1", () => {
    expect(parseMarkdown("intro\n- a")).toHaveLength(2);
    expect(parseMarkdown("born in\n1998. a good year")).toHaveLength(1);
  });

  it("reads Windows line endings and an empty source", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toHaveLength(2);
    expect(parseMarkdown("")).toEqual([]);
  });

  it("does not choke on deep nesting", () => {
    expect(() => parseMarkdown(`${">".repeat(60)} deep`)).not.toThrow();
    expect(() => parseMarkdown(`${"  ".repeat(30)}- deep`)).not.toThrow();
  });

  it("leaves html as text", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([{ t: "p", c: [text("<script>alert(1)</script>")] }]);
  });
});
