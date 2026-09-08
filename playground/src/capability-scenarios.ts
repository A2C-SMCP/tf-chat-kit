import type {
  ChatResourcePort,
  MessageContent,
  TimelineItem,
  ToolPresentation,
} from "@turingfocus/chat-protocol";
import type { ChatDocumentSource } from "@turingfocus/chat-runtime";

export const capabilityScenarios = [
  {
    id: "tools",
    title: "工具呈现",
    hint: "点击时间线中的工具，查看 Browser 截图、Preview 代码、Editor 差异、Shell 输出和 Download 产物；使用前后按钮或滑块切换。",
  },
  {
    id: "media",
    title: "媒体与资源",
    hint: "播放本地音视频，打开或下载文件；图片首次模拟授权过期，点击 Retry resource 恢复。所有素材都来自本地。",
  },
  {
    id: "markdown",
    title: "Markdown 与复制",
    hint: "查看表格、图片与代码高亮，分别复制两段代码；可点击本地文档链接。",
  },
  {
    id: "inspection",
    title: "长结果与事件导航",
    hint: "点击事件查看 Markdown 正文、历史状态标签和长结果，尝试展开与复制。开启 Follow latest 后，再点击追加事件。",
  },
  {
    id: "references",
    title: "文档引用",
    hint: "点击输入框上方 References，再点 Load references，选择文档、查看或编辑引用后发送；也可输入 / 打开选择器。",
  },
] as const;
export type CapabilityScenario = (typeof capabilityScenarios)[number]["id"];

const report = {
  uri: "private:demo-report",
  name: "chat-kit-report.txt",
  mimeType: "text/plain",
};
export const demoReferenceText =
  "引用验收标记：发送时必须包含此段完整原文。\n资源授权由集成应用负责，Chat Kit 只消费标准端口。";

export function createDemoPorts(): {
  resources: ChatResourcePort;
  documents: ChatDocumentSource;
} {
  let expired = true;
  return {
    resources: {
      resolve: (request) => {
        if (request.signal.aborted) throw new Error("Cancelled");
        if (request.resource.uri === "private:demo-retry" && expired) {
          expired = false;
          throw new Error("Demo authorization expired");
        }
        const paths: Readonly<Record<string, string>> = {
          "private:demo-report": "/demo/report.txt",
          "private:demo-image": "/demo/browser.svg",
          "private:demo-retry": "/demo/browser.svg",
        };
        const uri = paths[request.resource.uri] ?? request.resource.uri;
        return {
          url: new URL(
            uri,
            typeof location === "undefined"
              ? "http://localhost:3000"
              : location.href,
          ).href,
        };
      },
    },
    documents: {
      list: ({ query, signal }) =>
        signal.aborted
          ? []
          : [
              {
                id: "guide",
                title: "Chat Kit 接入指南",
                content: demoReferenceText,
              },
              {
                id: "checklist",
                title: "演示验收清单",
                content: "逐项验证工具、媒体、Markdown、事件导航和引用发送。",
              },
            ].filter((document) =>
              `${document.title} ${document.content}`.includes(query),
            ),
    },
  };
}

export function createCapabilityTimeline(
  scenario: CapabilityScenario,
  conversationId: string,
  prefix: string,
): readonly TimelineItem[] {
  const now = Date.now();
  const message = (content: MessageContent, index = 0): TimelineItem => ({
    kind: "message",
    id: `${prefix}-message-${index}`,
    conversationId,
    role: "assistant",
    createdAt: now + index,
    sequence: index,
    content,
  });
  if (scenario === "tools") {
    const tools: readonly [string, ToolPresentation][] = [
      [
        "Browser 示例",
        {
          kind: "browser",
          url: `${typeof location === "undefined" ? "http://localhost:3000" : location.origin}/demo/report.txt`,
          image: { uri: "private:demo-image" },
          markdown:
            "## 本地网页摘要\n截图和正文通过默认工具组件呈现。[打开演示报告](private:demo-report)",
        },
      ],
      [
        "Preview 示例",
        {
          kind: "preview",
          language: "typescript",
          code: "const greeting: string = 'Hello Chat Kit';\nconsole.log(greeting);",
        },
      ],
      [
        "Editor 示例",
        {
          kind: "editor",
          language: "typescript",
          original: "const mode = 'manual';\n",
          modified: "const mode = 'follow-latest';\n",
        },
      ],
      [
        "Shell 示例",
        {
          kind: "shell",
          command: "pnpm test",
          username: "demo",
          hostname: "localhost",
          path: "/chat-kit",
          output:
            "\u001b[32m✓ 资源与引用测试通过\u001b[0m\n\u001b[33m提示：这是只读演示输出\u001b[0m\n",
        },
      ],
      ["Download 示例", { kind: "download", resource: report }],
    ];
    return tools.map(([name, presentation], index) => ({
      kind: "agent-event",
      id: `${prefix}-tool-${index}`,
      conversationId,
      eventCategory: "tool",
      eventType: name,
      status: "success",
      createdAt: now + index,
      sequence: index,
      transitions: [
        {
          id: `${prefix}-return-${index}`,
          status: "success",
          occurredAt: now + index,
          toolCall: { name, arguments: { demo: true } },
          toolReturn: { presentation, success: true },
        },
      ],
    }));
  }
  if (scenario === "media")
    return [
      message({
        kind: "multipart",
        summary: "本地媒体与资源演示",
        parts: [
          {
            kind: "text",
            text: "### 本地媒体与资源\n音频为合成提示音，视频为合成测试画面，无外部网络依赖。",
          },
          {
            kind: "media",
            mediaType: "audio",
            summary: "提示音",
            resource: { uri: "/demo/tone.wav", name: "提示音" },
          },
          {
            kind: "media",
            mediaType: "video",
            summary: "测试画面",
            resource: { uri: "/demo/clip.webm", name: "测试画面" },
          },
          { kind: "file", summary: "演示报告", resource: report },
          {
            kind: "contact",
            summary: "演示联系人",
            displayName: "Chat Kit 演示助手",
          },
          { kind: "url", summary: "本地报告链接", resource: report },
          {
            kind: "media",
            mediaType: "image",
            summary: "可重试图片",
            resource: { uri: "private:demo-retry", name: "可重试图片" },
          },
        ],
      }),
    ];
  if (scenario === "markdown")
    return [
      message({
        kind: "text",
        text: '## Markdown 演示\n\n| 能力 | 状态 |\n| --- | --- |\n| 图片与表格 | 可用 |\n| 单代码块复制 | 可用 |\n\n```typescript\nconst first = \'只复制第一段\';\n```\n\n```json\n{"second": "只复制第二段"}\n```\n\n![本地截图](private:demo-image)\n\n[打开本地报告](private:demo-report)',
      }),
    ];
  if (scenario === "references")
    return [
      message({
        kind: "text",
        text: "## 文档引用演示\n\n选择 **Chat Kit 接入指南** 后发送，在用户消息中可看到完整原文及“引用验收标记”。引用可查看、编辑、删除，不会自动上传到任何外部服务。",
      }),
    ];
  return [
    {
      kind: "agent-event",
      id: `${prefix}-inspection`,
      conversationId,
      eventCategory: "generic",
      eventType: "检查演示",
      status: "success",
      summary: "结果检查与安全 Markdown",
      createdAt: now,
      sequence: 0,
      transitions: [
        {
          id: `${prefix}-running`,
          status: "running",
          occurredAt: now,
          sequence: 0,
          summary: "**正在整理** 已接收的结果。",
        },
        {
          id: `${prefix}-done`,
          status: "success",
          occurredAt: now + 1,
          sequence: 1,
          summary: "### 检查完成\n结果初始有界展示，可主动展开或复制。",
          content: {
            entries: Array.from({ length: 180 }, (_, index) => ({
              index,
              detail: "这是一条用于验证长结果展开的本地记录。",
            })),
          },
        },
      ],
    },
  ];
}
