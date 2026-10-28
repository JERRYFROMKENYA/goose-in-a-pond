import { Fragment, useMemo, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "../lib/markdownBlocks";
import "./markdown.css";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i): ReactNode => {
        switch (node.t) {
          case "text":
            return <Fragment key={i}>{node.v}</Fragment>;
          case "code":
            return (
              <code key={i} className="md__code">
                {node.v}
              </code>
            );
          case "strong":
            return (
              <strong key={i}>
                <Inlines nodes={node.c} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Inlines nodes={node.c} />
              </em>
            );
          case "link":
            return (
              <a key={i} href={node.href} target="_blank" rel="noopener noreferrer">
                <Inlines nodes={node.c} />
              </a>
            );
        }
      })}
    </>
  );
}

function Blocks({ blocks, tight }: { blocks: Block[]; tight?: boolean }) {
  // A list item holding one paragraph is drawn without the paragraph's margins.
  if (tight && blocks.length === 1 && blocks[0].t === "p") return <Inlines nodes={blocks[0].c} />;
  return (
    <>
      {blocks.map((block, i): ReactNode => {
        switch (block.t) {
          case "p":
            return (
              <p key={i} className="md__p">
                <Inlines nodes={block.c} />
              </p>
            );
          case "h": {
            const Tag = block.level <= 2 ? "h4" : block.level === 3 ? "h5" : "h6";
            return (
              <Tag key={i} className={`md__h md__h${block.level}`}>
                <Inlines nodes={block.c} />
              </Tag>
            );
          }
          case "ul":
            return (
              <ul key={i} className="md__list">
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Blocks blocks={item} tight />
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="md__list" start={block.start}>
                {block.items.map((item, j) => (
                  <li key={j}>
                    <Blocks blocks={item} tight />
                  </li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={i} className="md__quote">
                <Blocks blocks={block.c} />
              </blockquote>
            );
          case "code":
            return (
              <pre key={i} className="md__pre">
                <code>{block.v}</code>
              </pre>
            );
          case "hr":
            return <hr key={i} className="md__hr" />;
        }
      })}
    </>
  );
}

/** Draws markdown the pond wrote as elements, never as HTML, so nothing in it can run. */
export function MarkdownText({ source, className }: { source: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <Blocks blocks={blocks} />
    </div>
  );
}
