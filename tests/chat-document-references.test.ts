import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  appendComposerReference,
  emptyComposerDraft,
  resolveComposerDraftText,
  rebaseComposerLongTexts,
} from "../packages/chat-runtime/src/index.js";
import {
  ChatDocumentSourceProvider,
  type ChatDocumentReference,
} from "../packages/chat-react/src/index.js";
import { ChatReferencePicker } from "../packages/chat-ui-antd/src/reference-picker.js";

it("expands same-name references by anchor identity without truncating authorized content", () => {
  const initial = emptyComposerDraft("independent");
  const first = {
    ...initial,
    ...appendComposerReference(
      initial,
      { id: "a", title: "Same", content: "A".repeat(20_000) },
      "one",
    ),
  };
  const second = {
    ...first,
    ...appendComposerReference(
      first,
      { id: "b", title: "Same", content: "B" },
      "two",
    ),
  };
  expect(resolveComposerDraftText(second)).toBe(
    `Same\n${"A".repeat(20_000)} Same\nB`,
  );
  const newText = `Ask ${second.text}`;
  const edited = {
    ...second,
    text: newText,
    longTexts: rebaseComposerLongTexts(second.text, newText, second.longTexts),
  };
  expect(resolveComposerDraftText(edited)).toBe(
    `Ask Same\n${"A".repeat(20_000)} Same\nB`,
  );
  expect(() =>
    appendComposerReference(
      first,
      { id: "a", title: "Same", content: "x" },
      "one",
    ),
  ).toThrow();
});

it("discards late document candidates after authorization changes and supports retry", async () => {
  const pending: Array<(value: readonly ChatDocumentReference[]) => void> = [];
  const cancel = vi.fn();
  const source = {
    list: vi.fn(
      (request: {
        signal: { subscribe(listener: () => void): () => void };
      }) => {
        request.signal.subscribe(cancel);
        return new Promise<readonly ChatDocumentReference[]>((resolve) =>
          pending.push(resolve),
        );
      },
    ),
  };
  const onSelect = vi.fn();
  const tree = (scope: string) =>
    createElement(
      ChatDocumentSourceProvider,
      { source, scope },
      createElement(ChatReferencePicker, {
        conversationId: "one",
        onSelect,
        onClose: vi.fn(),
      }),
    );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(tree("a"));
  });
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Load references"))
      ?.props["onClick"](),
  );
  await act(async () => renderer.update(tree("b")));
  expect(cancel).toHaveBeenCalledOnce();
  await act(async () =>
    pending[0]?.([{ id: "private", title: "Old account", content: "hidden" }]),
  );
  expect(JSON.stringify(renderer.toJSON())).not.toContain("Old account");
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Load references"))
      ?.props["onClick"](),
  );
  await act(async () =>
    pending[1]?.([{ id: "new", title: "Current account", content: "visible" }]),
  );
  act(() =>
    renderer.root
      .findAllByType("button")
      .find((button) => button.children.includes("Current account"))
      ?.props["onClick"](),
  );
  expect(onSelect).toHaveBeenCalledWith({
    id: "new",
    title: "Current account",
    content: "visible",
  });
  act(() => renderer.unmount());
});
