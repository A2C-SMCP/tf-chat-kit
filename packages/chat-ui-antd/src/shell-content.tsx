import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { theme } from "antd";
import type { ToolPresentation } from "@turingfocus/chat-protocol";

interface TerminalPart {
  readonly text: string;
  readonly color?: number | undefined;
  readonly bold: boolean;
}

/** Read-only SGR decoder: OSC, cursor movement, and terminal commands never execute. */
export function decodeTerminalOutput(output: string): readonly TerminalPart[] {
  const parts: TerminalPart[] = [];
  let color: number | undefined;
  let bold = false;
  let text = "";
  const flush = (): void => {
    if (text) parts.push({ text, color, bold });
    text = "";
  };
  for (let index = 0; index < output.length; index += 1) {
    const character = output[index]!;
    if (character === "\x1b") {
      flush();
      if (output[index + 1] === "[") {
        const start = index + 2;
        index = start;
        while (index < output.length && !/[@-~]/.test(output[index]!))
          index += 1;
        if (output[index] === "m")
          for (const code of output
            .slice(start, index)
            .split(";")
            .map(Number)) {
            if (code === 0) {
              color = undefined;
              bold = false;
            } else if (code === 1) bold = true;
            else if (code === 22) bold = false;
            else if (code === 39) color = undefined;
            else if (code >= 30 && code <= 37) color = code - 30;
            else if (code >= 90 && code <= 97) color = code - 90;
          }
      } else if (output[index + 1] === "]") {
        index += 2;
        while (
          index < output.length &&
          output[index] !== "\x07" &&
          !(output[index] === "\x1b" && output[index + 1] === "\\")
        )
          index += 1;
        if (output[index] === "\x1b") index += 1;
      } else index += 1;
    } else if (
      character === "\n" ||
      character === "\t" ||
      (character.charCodeAt(0) >= 32 && character !== "\x7f")
    )
      text += character;
  }
  flush();
  return parts;
}

export function ShellContent({
  presentation,
}: {
  readonly presentation: Extract<ToolPresentation, { kind: "shell" }>;
}): ReactNode {
  const { token } = theme.useToken();
  const [expanded, setExpanded] = useState(false);
  const output = expanded
    ? presentation.output
    : presentation.output.slice(0, 4_000);
  const parts = useMemo(() => decodeTerminalOutput(output), [output]);
  const colors = [
    token.colorText,
    token.colorErrorText,
    token.colorSuccessText,
    token.colorWarningText,
    token.colorPrimaryText,
    token.colorInfoText,
    token.colorInfoText,
    token.colorText,
  ];
  return (
    <section
      aria-label="Shell result"
      style={{
        background: token.colorBgContainer,
        color: token.colorText,
        minWidth: 0,
      }}
    >
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {[presentation.username, presentation.hostname]
          .filter(Boolean)
          .join("@")}{" "}
        {presentation.path}
        {"\n"}
        {presentation.command}
      </pre>
      <pre
        aria-label="Terminal output"
        tabIndex={0}
        style={{
          overflow: "auto",
          maxHeight: "32rem",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {parts.map((part, index) => {
          const style: CSSProperties = {
            color: part.color === undefined ? undefined : colors[part.color],
            fontWeight: part.bold ? "bold" : undefined,
          };
          return (
            <span key={index} style={style}>
              {part.text}
            </span>
          );
        })}
      </pre>
      {presentation.output.length > 4_000 && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "Collapse output"
            : `Show full output (${presentation.output.length} characters)`}
        </button>
      )}
    </section>
  );
}
