import {
  Component,
  createRef,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { theme } from "antd";

export interface ChatCodeContentProps {
  readonly code: string;
  readonly language?: string | undefined;
  readonly title?: string | undefined;
}

interface CodeTextProps {
  readonly text: string;
  readonly html: string | undefined;
}
interface CodeSelection {
  readonly anchor: number;
  readonly focus: number;
}

/** Snapshot before React mutates syntax nodes, then restore text-relative selection. */
class CodeText extends Component<CodeTextProps, object, CodeSelection | null> {
  private readonly element = createRef<HTMLElement>();
  override getSnapshotBeforeUpdate(
    previous: CodeTextProps,
  ): CodeSelection | null {
    const element = this.element.current;
    const selection = element?.ownerDocument.getSelection();
    if (
      !element ||
      !selection ||
      selection.isCollapsed ||
      !element.contains(selection.anchorNode) ||
      !element.contains(selection.focusNode)
    )
      return null;
    const offset = (node: Node | null, position: number): number => {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      if (node !== null) range.setEnd(node, position);
      return range.toString().length;
    };
    const anchor = offset(selection.anchorNode, selection.anchorOffset);
    const focus = offset(selection.focusNode, selection.focusOffset);
    const end = Math.max(anchor, focus);
    return previous.text.slice(0, end) === this.props.text.slice(0, end)
      ? { anchor, focus }
      : null;
  }
  override componentDidUpdate(
    _previous: CodeTextProps,
    _state: object,
    snapshot: CodeSelection | null,
  ): void {
    const element = this.element.current;
    if (!element || !snapshot) return;
    const point = (offset: number): { node: Node; offset: number } => {
      const walker = element.ownerDocument.createTreeWalker(element, 4);
      let node = walker.nextNode();
      while (node !== null) {
        const length = node.textContent?.length ?? 0;
        if (offset <= length) return { node, offset };
        offset -= length;
        node = walker.nextNode();
      }
      return { node: element, offset: element.childNodes.length };
    };
    const anchor = point(snapshot.anchor);
    const focus = point(snapshot.focus);
    element.ownerDocument
      .getSelection()
      ?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }
  override render(): ReactNode {
    return this.props.html === undefined ? (
      <code ref={this.element}>{this.props.text}</code>
    ) : (
      <code
        ref={this.element}
        dangerouslySetInnerHTML={{ __html: this.props.html }}
      />
    );
  }
}

export function ChatCodeContent({
  code,
  language,
  title = "Code",
}: ChatCodeContentProps): ReactNode {
  const { token } = theme.useToken();
  const [wrap, setWrap] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState<"success" | "failed">();
  const [highlight, setHighlight] = useState<{
    code: string;
    language: string | undefined;
    html: string | undefined;
  }>();
  const visible = expanded ? code : code.slice(0, 4_000);
  useEffect(() => {
    let active = true;
    void import("./code-highlight.js")
      .then(({ highlightCode }) => {
        const html = highlightCode(visible, language);
        if (active) setHighlight({ code: visible, language, html });
      })
      .catch(() => {
        if (active) setHighlight(undefined);
      });
    return () => {
      active = false;
    };
  }, [visible, language]);
  const html =
    highlight?.code === visible && highlight.language === language
      ? highlight.html
      : undefined;
  const lines = useMemo(() => visible.split("\n").length, [visible]);
  return (
    <section
      data-chat-code=""
      aria-label={title}
      style={{
        background: token.colorFillQuaternary,
        color: token.colorText,
        minWidth: 0,
      }}
    >
      <style>
        {
          "[data-chat-code] .hljs-keyword,[data-chat-code] .hljs-literal{color:var(--chat-code-keyword)}[data-chat-code] .hljs-string,[data-chat-code] .hljs-comment{color:var(--chat-code-string)}"
        }
      </style>
      <div>
        <span>
          {title} · {language ?? "text"}
        </span>
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          Wrap lines
        </button>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(code))
              .then(() => setCopied("success"))
              .catch(() => setCopied("failed"));
          }}
        >
          Copy code
        </button>
        {copied !== undefined && (
          <span role="status">
            {copied === "success" ? "Copied" : "Copy failed"}
          </span>
        )}
      </div>
      <div style={{ display: "flex", overflow: "auto", maxHeight: "32rem" }}>
        <pre
          aria-hidden="true"
          style={{
            padding: 8,
            userSelect: "none",
            color: token.colorTextSecondary,
          }}
        >
          {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
        </pre>
        <pre
          style={{
            margin: 0,
            padding: 8,
            whiteSpace: wrap ? "pre-wrap" : "pre",
            overflowWrap: "anywhere",
            flex: 1,
            ...{
              "--chat-code-keyword": token.colorPrimary,
              "--chat-code-string": token.colorSuccessText,
            },
          }}
        >
          <CodeText text={visible} html={html} />
        </pre>
      </div>
      {code.length > 4_000 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Collapse code"
            : `Show full code (${code.length} characters)`}
        </button>
      )}
    </section>
  );
}

export function ChatCodeDiff({
  original,
  modified,
  language,
}: {
  readonly original: string;
  readonly modified: string;
  readonly language?: string | undefined;
}): ReactNode {
  const [diff, setDiff] = useState<{
    original: string;
    modified: string;
    text: string;
  }>();
  useEffect(() => {
    let active = true;
    if (original.length + modified.length <= 80_000) {
      void import("diff")
        .then(({ diffLines }) => {
          const changes = diffLines(original, modified, {
            maxEditLength: 1_000,
            timeout: 50,
          });
          if (active && changes !== undefined)
            setDiff({
              original,
              modified,
              text: changes
                .map((part) =>
                  part.value
                    .split(/(?<=\n)/)
                    .map(
                      (line) =>
                        `${part.added ? "+" : part.removed ? "-" : " "}${line}`,
                    )
                    .join(""),
                )
                .join(""),
            });
        })
        .catch(() => {
          if (active) setDiff(undefined);
        });
    }
    return () => {
      active = false;
    };
  }, [original, modified]);
  return (
    <div aria-label="Read-only diff" style={{ minWidth: 0 }}>
      {diff?.original === original && diff.modified === modified ? (
        <ChatCodeContent
          code={diff.text}
          title="Changes (+ added, - removed)"
        />
      ) : (
        <span>
          Diff unavailable or loading; both complete versions are below.
        </span>
      )}
      <ChatCodeContent code={original} language={language} title="Original" />
      <ChatCodeContent code={modified} language={language} title="Modified" />
    </div>
  );
}
