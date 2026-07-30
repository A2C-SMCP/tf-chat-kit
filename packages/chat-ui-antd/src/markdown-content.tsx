import { Typography, theme } from "antd";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export interface ChatMarkdownContentProps {
  readonly children: string;
}

/**
 * Safe Markdown content only. Message/event chrome belongs to the caller so
 * content rendering can be reused without coupling author or status layout.
 */
export const ChatMarkdownContent = ({
  children,
}: ChatMarkdownContentProps): ReactNode => {
  const { token } = theme.useToken();
  return (
    <ReactMarkdown
      components={{
        a: ({ children: linkChildren, href }) => (
          <Typography.Link href={href} rel="noreferrer" target="_blank">
            {linkChildren}
          </Typography.Link>
        ),
        img: ({ alt }) => (
          <Typography.Text type="secondary">
            {alt === undefined || alt.length === 0
              ? "[Image]"
              : `[Image: ${alt}]`}
          </Typography.Text>
        ),
        p: ({ children: paragraphChildren }) => (
          <Typography.Paragraph style={{ marginBottom: token.marginXS }}>
            {paragraphChildren}
          </Typography.Paragraph>
        ),
      }}
      rehypePlugins={[rehypeSanitize]}
      remarkPlugins={[remarkGfm]}
      skipHtml
    >
      {children}
    </ReactMarkdown>
  );
};
