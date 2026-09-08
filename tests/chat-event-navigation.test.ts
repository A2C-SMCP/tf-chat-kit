import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";
import {
  useChatEventNavigation,
  type ChatEventNavigationBinding,
} from "../packages/chat-react/src/index.js";

it("keeps manual selection across prepends and new events, and follows only on request", () => {
  let binding: ChatEventNavigationBinding | undefined;
  const onSelect = vi.fn();
  function Consumer({
    ids,
    selected,
    scope,
  }: {
    ids: readonly string[];
    selected: string | null;
    scope: string;
  }) {
    binding = useChatEventNavigation({
      eventIds: ids,
      selectedEventId: selected,
      scope,
      onSelect,
    });
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      createElement(Consumer, { ids: [], selected: null, scope: "one" }),
    );
  });
  expect(binding).toMatchObject({
    count: 0,
    index: -1,
    canNext: false,
    canPrevious: false,
  });
  act(() =>
    renderer.update(
      createElement(Consumer, { ids: ["a", "b"], selected: "a", scope: "one" }),
    ),
  );
  expect(onSelect).not.toHaveBeenCalled();
  act(() => binding?.select(1));
  expect(onSelect).toHaveBeenLastCalledWith("b");
  onSelect.mockClear();
  act(() =>
    renderer.update(
      createElement(Consumer, {
        ids: ["history", "a", "b", "new"],
        selected: "b",
        scope: "one",
      }),
    ),
  );
  expect(binding?.index).toBe(2);
  expect(onSelect).not.toHaveBeenCalled();
  act(() => binding?.followLatest());
  expect(onSelect).toHaveBeenLastCalledWith("new");
  act(() =>
    renderer.update(
      createElement(Consumer, {
        ids: ["a", "b", "new", "newer"],
        selected: "new",
        scope: "one",
      }),
    ),
  );
  expect(onSelect).toHaveBeenLastCalledWith("newer");
  onSelect.mockClear();
  act(() =>
    renderer.update(
      createElement(Consumer, { ids: ["other"], selected: null, scope: "two" }),
    ),
  );
  expect(binding?.mode).toBe("manual");
  expect(onSelect).not.toHaveBeenCalled();
  act(() => renderer.unmount());
});
