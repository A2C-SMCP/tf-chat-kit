import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  decodeTerminalOutput,
  ShellContent,
} from "../packages/chat-ui-antd/src/shell-content.js";

it("renders Unicode ANSI output while discarding executable terminal controls", () => {
  const output =
    "\x1b[31m错误\x1b[0m\x1b]8;;javascript:alert(1)\x07link\x1b]8;;\x07\x1b[2J\n<script>";
  expect(decodeTerminalOutput(output)).toContainEqual({
    text: "错误",
    color: 1,
    bold: false,
  });
  const html = renderToStaticMarkup(
    createElement(ShellContent, {
      presentation: {
        kind: "shell",
        output,
        command: "ls",
        username: "user",
        hostname: "host",
        path: "/tmp",
      },
    }),
  );
  expect(html).toContain("user@host /tmp");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("\x1b");
});

it("bounds initial terminal output and handles empty or incomplete sequences", () => {
  expect(decodeTerminalOutput("")).toEqual([]);
  expect(
    decodeTerminalOutput("visible\x1b]unfinished")
      .map((part) => part.text)
      .join(""),
  ).toBe("visible");
  const start = performance.now();
  const html = renderToStaticMarkup(
    createElement(ShellContent, {
      presentation: { kind: "shell", output: "行".repeat(200_000) },
    }),
  );
  expect(html).toContain("200000 characters");
  expect(html.length).toBeLessThan(10_000);
  expect(performance.now() - start).toBeLessThan(1_000);
});
