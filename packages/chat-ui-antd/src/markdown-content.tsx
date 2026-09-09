import { Typography, theme } from "antd";
import { isValidElement, lazy, Suspense, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useResourceLabels } from "./resource-labels.js";
import { ChatResourceView } from "./resource-content.js";

export interface ChatMarkdownContentProps {
  readonly children: string;
}

const Code = lazy(() =>
  import("./code-content.js").then((module) => ({
    default: module.ChatCodeContent,
  })),
);
const Paragraph = ({
  children,
}: {
  readonly children?: ReactNode;
}): ReactNode => {
  const { token } = theme.useToken();
  return (
    <Typography.Paragraph style={{ marginBottom: token.marginXS }}>
      {children}
    </Typography.Paragraph>
  );
};
const CodeBlock = ({
  children,
}: {
  readonly children?: ReactNode;
}): ReactNode => {
  if (
    !isValidElement<{ children?: ReactNode; className?: string }>(children) ||
    typeof children.props.children !== "string"
  )
    return <pre>{children}</pre>;
  const code = children.props.children.replace(/\n$/, "");
  const language = children.props.className?.match(/language-([^\s]+)/)?.[1];
  return (
    <Suspense fallback={<pre>{code.slice(0, 4_000)}</pre>}>
      <Code code={code} language={language} />
    </Suspense>
  );
};
// Component identities stay stable during streaming updates.
const components: Components = {
  a: ({ children, href }) =>
    href ? (
      <ChatResourceView resource={{ uri: href }} inline>
        {children}
      </ChatResourceView>
    ) : (
      <span>{children}</span>
    ),
  img: function ResourceImage({ alt, src }) {
    const labels = useResourceLabels();
    return src ? (
      <ChatResourceView
        resource={{ uri: src }}
        kind="image"
        label={alt || labels.image}
      />
    ) : (
      <span>{alt || labels.unknown}</span>
    );
  },
  p: Paragraph,
  pre: CodeBlock,
};
const schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https", "blob", "s3", "private"],
    href: ["http", "https", "blob", "s3", "private", "mailto"],
  },
};

/** Safe, resource-aware GFM; raw HTML remains disabled. */
export const ChatMarkdownContent = ({
  children,
}: ChatMarkdownContentProps): ReactNode => (
  <ReactMarkdown
    components={components}
    rehypePlugins={[[rehypeSanitize, schema]]}
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={(url) => url}
  >
    {children}
  </ReactMarkdown>
);
