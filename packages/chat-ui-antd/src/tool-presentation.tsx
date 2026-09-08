import { lazy, Suspense, type ReactNode } from "react";
import type { ToolPresentation } from "@turingfocus/chat-protocol";
import { ChatMarkdownContent } from "./markdown-content.js";
import { ChatResourceView } from "./resource-content.js";

const Shell = lazy(() =>
  import("./shell-content.js").then((module) => ({
    default: module.ShellContent,
  })),
);
const Code = lazy(() =>
  import("./code-content.js").then((module) => ({
    default: module.ChatCodeContent,
  })),
);
const Diff = lazy(() =>
  import("./code-content.js").then((module) => ({
    default: module.ChatCodeDiff,
  })),
);

export function ToolPresentationView({
  presentation,
}: {
  readonly presentation: ToolPresentation;
}): ReactNode {
  if (presentation.kind === "browser")
    return (
      <section
        aria-label="Browser result"
        style={{ minWidth: 0, overflowWrap: "anywhere" }}
      >
        {presentation.url === undefined ? null : (
          <ChatResourceView
            resource={{ uri: presentation.url }}
            label={presentation.url}
          />
        )}
        {presentation.image === undefined ? null : (
          <ChatResourceView
            resource={presentation.image}
            kind="image"
            label="Browser screenshot"
          />
        )}
        {presentation.markdown === undefined ? null : (
          <ChatMarkdownContent>{presentation.markdown}</ChatMarkdownContent>
        )}
      </section>
    );
  if (presentation.kind === "preview")
    return (
      <Suspense fallback={<pre>{presentation.code.slice(0, 4_000)}</pre>}>
        <Code code={presentation.code} language={presentation.language} />
      </Suspense>
    );
  if (presentation.kind === "editor")
    return (
      <Suspense fallback={<span>Loading code diff</span>}>
        <Diff
          original={presentation.original}
          modified={presentation.modified}
          language={presentation.language}
        />
      </Suspense>
    );
  if (presentation.kind === "shell")
    return (
      <Suspense fallback={<pre>{presentation.output.slice(0, 4_000)}</pre>}>
        <Shell presentation={presentation} />
      </Suspense>
    );
  if (presentation.kind === "download")
    return (
      <ChatResourceView
        resource={presentation.resource}
        label={presentation.resource.name ?? "Generated file"}
      />
    );
  return null;
}
