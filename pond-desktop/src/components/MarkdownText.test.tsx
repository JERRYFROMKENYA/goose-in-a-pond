import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MarkdownText } from "./MarkdownText";

afterEach(cleanup);

function drawn(source: string): HTMLElement {
  const { container } = render(<MarkdownText source={source} />);
  return container.firstElementChild as HTMLElement;
}

describe("MarkdownText", () => {
  it("draws headings small enough to sit inside a chat", () => {
    const root = drawn("# One\n\n## Two\n\n### Three\n\n#### Four");
    expect(root.querySelectorAll("h1, h2, h3")).toHaveLength(0);
    expect(root.querySelector("h4")?.textContent).toBe("One");
    expect(root.querySelectorAll("h4")).toHaveLength(2);
    expect(root.querySelector("h5")?.textContent).toBe("Three");
    expect(root.querySelector("h6")?.textContent).toBe("Four");
  });

  it("draws emphasis, code and a paragraph", () => {
    const root = drawn("Some **bold**, *slanted* and `code`.");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("slanted");
    expect(root.querySelector("code")?.textContent).toBe("code");
    expect(root.querySelector("p")?.textContent).toBe("Some bold, slanted and code.");
  });

  it("opens a web link in a new window that cannot reach back", () => {
    const link = drawn("[ferry times](https://example.com/ferry)").querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/ferry");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("draws a link that is not to the web as plain text", () => {
    const root = drawn("[click](javascript:alert(1))");
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).toContain("click");
  });

  it("never turns the pond's text into elements", () => {
    const root = drawn('<img src=x onerror="alert(1)"><script>alert(1)</script>');
    expect(root.querySelector("img, script")).toBeNull();
    expect(root.textContent).toContain("<script>");
  });

  it("draws a list with no paragraph inside a one-line item, and a nested list inside another", () => {
    const root = drawn("- one\n- two\n  - inner");
    const items = Array.from(root.querySelector("ul")?.children ?? []);
    expect(items).toHaveLength(2);
    expect(items[0].querySelector("p")).toBeNull();
    expect(items[0].textContent).toBe("one");
    expect(items[1].querySelector("ul li")?.textContent).toBe("inner");
  });

  it("starts a numbered list where the text says", () => {
    expect(drawn("3. a\n4. b").querySelector("ol")?.getAttribute("start")).toBe("3");
  });

  it("draws a code block in a pre, with its marks left alone", () => {
    const pre = drawn("```\n# not a heading\n**nor bold**\n```").querySelector("pre");
    expect(pre?.textContent).toBe("# not a heading\n**nor bold**");
    expect(pre?.querySelector("strong, h4")).toBeNull();
  });

  it("draws a quote and a rule", () => {
    const root = drawn("> said\n\n---");
    expect(root.querySelector("blockquote")?.textContent).toBe("said");
    expect(root.querySelector("hr")).not.toBeNull();
  });

  it("draws nothing for an empty source", () => {
    expect(drawn("").textContent).toBe("");
  });
});
