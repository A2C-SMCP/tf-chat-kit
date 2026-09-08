// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { mapEvent } from "../packages/chat-gateway-tfrobot/src/mapper.js";
import {
  ChatTimelineItem,
  createChatRendererRegistry,
} from "../packages/chat-ui-antd/src/index.js";

it.each([
  {
    url: "https://example.com",
    image: "https://example.com/screen.png",
    content: "# Page result",
  },
  { url: "https://example.com" },
  { content: "# Page result" },
])(
  "renders normalized Browser partial result %j through the default registry",
  (origin) => {
    const item = mapEvent({
      eventId: "browser",
      conversationId: "42",
      status: "success",
      eventScene: "Tool",
      createTimestamp: 10,
      content: { toolReturn: { origin, meta: { success: true } } },
    });
    const html = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item,
        displayMode: "detail",
        registry: createChatRendererRegistry(),
        formatTimestamp: String,
      }),
    );
    expect(html).toContain("Browser result");
    expect(html).not.toContain("iframe");
    if ("content" in origin) expect(html).toContain("<h1>Page result</h1>");
    if ("image" in origin) expect(html).toContain('alt="Browser screenshot"');
    const overridden = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item,
        formatTimestamp: String,
        registry: createChatRendererRegistry({
          "agent-event:tool": () => createElement("p", null, "Host override"),
        }),
      }),
    );
    expect(overridden).toContain("Host override");
  },
);

it("renders Download and mixed tool attachments through the shared resource controls", () => {
  const item = mapEvent({
    eventId: "artifacts",
    conversationId: "42",
    status: "failed",
    eventScene: "Tool",
    createTimestamp: 10,
    content: {
      toolReturn: {
        origin: {
          url: "https://example.com/report.pdf",
          filename: "report.pdf",
        },
        meta: { success: false },
        attachments: [
          {
            category: "image",
            attachment: "https://example.com/screenshot.png",
          },
          { category: "audio", attachment: "s3://bucket/audio.mp3" },
          { category: "future", attachment: "private:unknown" },
        ],
      },
    },
  });
  const html = renderToStaticMarkup(
    createElement(ChatTimelineItem, {
      item,
      registry: createChatRendererRegistry(),
    }),
  );
  expect(html).toContain("report.pdf");
  expect(html.match(/>Download</g)).toHaveLength(4);
  expect(html).toContain("image attachment 1");
  expect(html).toContain("Tool failed");
  expect(html).not.toContain("s3://");
});

it("shows normalized media, contact and URL messages without reading raw", async () => {
  const { mapMessage } =
    await import("../packages/chat-gateway-tfrobot/src/mapper.js");
  const base = {
    msgId: "media",
    conversationId: "42",
    role: "assistant",
    createTimestamp: 10,
    additionalKwargs: {},
    attachments: null,
  };
  for (const [msgType, content, expected] of [
    ["audio", "https://example.com/audio.mp3", "<audio"],
    ["video", "https://example.com/video.mp4", "<video"],
    [
      "contact",
      { name: "Contact name", avatar: "https://example.com/avatar.png" },
      "Contact name",
    ],
    ["url", "https://example.com/page", ">Open<"],
    [
      "multipart",
      [
        {
          partType: "audio_url",
          audioUrl: { url: "https://example.com/a.mp3" },
        },
        { partType: "text", text: "mixed" },
      ],
      "<audio",
    ],
  ] as const) {
    const item = mapMessage({ ...base, msgType, content });
    const html = renderToStaticMarkup(
      createElement(ChatTimelineItem, {
        item,
        registry: createChatRendererRegistry(),
      }),
    );
    expect(html).toContain(expected);
  }
});
