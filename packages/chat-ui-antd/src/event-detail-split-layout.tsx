import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { theme } from "antd";

export const DEFAULT_EVENT_DETAIL_SPLIT_RATIO = 0.56;
export const MIN_EVENT_DETAIL_SPLIT_RATIO = 0.2;
export const MAX_EVENT_DETAIL_SPLIT_RATIO = 0.8;

const EVENT_DETAIL_SPLIT_KEYBOARD_STEP = 0.02;
const EVENT_DETAIL_SPLIT_RATIO_PRECISION = 10_000;

export const normalizeEventDetailSplitRatio = (
  value: number | undefined,
  fallback = DEFAULT_EVENT_DETAIL_SPLIT_RATIO,
): number => {
  const finiteFallback = Number.isFinite(fallback)
    ? fallback
    : DEFAULT_EVENT_DETAIL_SPLIT_RATIO;
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : finiteFallback;
  return (
    Math.round(
      Math.min(
        MAX_EVENT_DETAIL_SPLIT_RATIO,
        Math.max(MIN_EVENT_DETAIL_SPLIT_RATIO, candidate),
      ) * EVENT_DETAIL_SPLIT_RATIO_PRECISION,
    ) / EVENT_DETAIL_SPLIT_RATIO_PRECISION
  );
};

interface ActivePointerResize {
  readonly direction: "ltr" | "rtl";
  readonly pointerId: number;
  readonly rect: DOMRect;
}

export interface EventDetailSplitLayoutProps {
  readonly ariaLabel: string;
  readonly detail: ReactNode;
  readonly onRatioChange?: ((ratio: number) => void) | undefined;
  readonly ratio: number;
  readonly resizable?: boolean | undefined;
  readonly split: boolean;
  readonly timeline: ReactNode;
}

const ratioFromClientX = (
  clientX: number,
  resize: ActivePointerResize,
): number => {
  const offset =
    resize.direction === "rtl"
      ? resize.rect.right - clientX
      : clientX - resize.rect.left;
  return normalizeEventDetailSplitRatio(offset / resize.rect.width);
};

/**
 * Internal split layout. Pointer movement remains local so resizing does not
 * force the conversation view or its virtualized timeline to rerender.
 */
export const EventDetailSplitLayout = ({
  ariaLabel,
  detail,
  onRatioChange,
  ratio,
  resizable = true,
  split,
  timeline,
}: EventDetailSplitLayoutProps) => {
  const { token } = theme.useToken();
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<ActivePointerResize | null>(null);
  const [dragRatio, setDragRatio] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const committedRatio = normalizeEventDetailSplitRatio(ratio);
  const renderedRatio = dragRatio ?? committedRatio;

  const commitRatio = useCallback(
    (nextValue: number) => {
      const nextRatio = normalizeEventDetailSplitRatio(nextValue);
      if (nextRatio !== committedRatio) onRatioChange?.(nextRatio);
      setDragRatio(null);
    },
    [committedRatio, onRatioChange],
  );

  const clearPointerResize = useCallback(() => {
    activePointerRef.current = null;
    setDragging(false);
  }, []);

  useEffect(() => {
    if (split) return;
    clearPointerResize();
    setDragRatio(null);
  }, [clearPointerResize, split]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const layout = layoutRef.current;
      if (!resizable || event.button !== 0 || layout === null) return;
      const rect = layout.getBoundingClientRect();
      if (!Number.isFinite(rect.width) || rect.width <= 0) return;

      event.preventDefault();
      activePointerRef.current = {
        direction:
          globalThis.getComputedStyle(layout).direction === "rtl"
            ? "rtl"
            : "ltr",
        pointerId: event.pointerId,
        rect,
      };
      setDragRatio(committedRatio);
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [committedRatio, resizable],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const resize = activePointerRef.current;
      if (resize === null || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      setDragRatio(ratioFromClientX(event.clientX, resize));
    },
    [],
  );

  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const resize = activePointerRef.current;
      if (resize === null || resize.pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextRatio = ratioFromClientX(event.clientX, resize);
      clearPointerResize();
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      commitRatio(nextRatio);
    },
    [clearPointerResize, commitRatio],
  );

  const cancelPointerResize = useCallback(
    (event?: PointerEvent<HTMLDivElement>) => {
      const resize = activePointerRef.current;
      if (
        resize === null ||
        (event !== undefined && resize.pointerId !== event.pointerId)
      ) {
        return;
      }
      clearPointerResize();
      if (event !== undefined) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      setDragRatio(null);
    },
    [clearPointerResize],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!resizable) return;
      const direction =
        layoutRef.current !== null &&
        globalThis.getComputedStyle(layoutRef.current).direction === "rtl"
          ? "rtl"
          : "ltr";
      let nextRatio: number | undefined;

      switch (event.key) {
        case "ArrowLeft":
          nextRatio =
            committedRatio +
            (direction === "rtl"
              ? EVENT_DETAIL_SPLIT_KEYBOARD_STEP
              : -EVENT_DETAIL_SPLIT_KEYBOARD_STEP);
          break;
        case "ArrowRight":
          nextRatio =
            committedRatio +
            (direction === "rtl"
              ? -EVENT_DETAIL_SPLIT_KEYBOARD_STEP
              : EVENT_DETAIL_SPLIT_KEYBOARD_STEP);
          break;
        case "Home":
          nextRatio = MIN_EVENT_DETAIL_SPLIT_RATIO;
          break;
        case "End":
          nextRatio = MAX_EVENT_DETAIL_SPLIT_RATIO;
          break;
        default:
          return;
      }

      event.preventDefault();
      commitRatio(nextRatio);
    },
    [commitRatio, committedRatio, resizable],
  );

  const active = dragging || focused;
  const ratioPercent = Math.round(renderedRatio * 100);

  return (
    <div
      data-chat-event-split-ratio={renderedRatio}
      ref={layoutRef}
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        width: "100%",
      }}
    >
      <div
        style={{
          boxSizing: "border-box",
          flex: `0 0 ${split ? renderedRatio * 100 : 100}%`,
          minHeight: 0,
          minWidth: 0,
        }}
      >
        {timeline}
      </div>
      {split ? (
        <>
          <div
            aria-disabled={!resizable || undefined}
            aria-label={ariaLabel}
            aria-orientation="vertical"
            aria-valuemax={MAX_EVENT_DETAIL_SPLIT_RATIO * 100}
            aria-valuemin={MIN_EVENT_DETAIL_SPLIT_RATIO * 100}
            aria-valuenow={ratioPercent}
            aria-valuetext={`${ratioPercent}%`}
            data-chat-event-split-handle=""
            onBlur={() => setFocused(false)}
            onFocus={() => setFocused(true)}
            onKeyDown={handleKeyDown}
            onLostPointerCapture={() => cancelPointerResize()}
            onPointerCancel={cancelPointerResize}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            role="separator"
            style={{
              alignSelf: "stretch",
              background: active
                ? token.colorPrimary
                : token.colorBorderSecondary,
              boxShadow: focused
                ? `0 0 0 ${token.lineWidthFocus}px ${token.colorPrimaryBorder}`
                : undefined,
              cursor: resizable ? "col-resize" : "default",
              flex: "0 0 1px",
              marginInline: -0.5,
              outline: "none",
              position: "relative",
              touchAction: "none",
              userSelect: "none",
              zIndex: 2,
            }}
            tabIndex={resizable ? 0 : -1}
          >
            <span
              aria-hidden="true"
              style={{
                cursor: resizable ? "col-resize" : "default",
                insetBlock: 0,
                insetInlineStart: "50%",
                position: "absolute",
                transform: "translateX(-50%)",
                width: 12,
              }}
            />
          </div>
          <div
            style={{
              flex: "1 1 0",
              minHeight: 0,
              minWidth: 0,
              overflow: "auto",
            }}
          >
            {detail}
          </div>
        </>
      ) : null}
      {dragging && split ? (
        <div
          aria-hidden="true"
          style={{
            cursor: "col-resize",
            inset: 0,
            position: "fixed",
            zIndex: token.zIndexPopupBase,
          }}
        />
      ) : null}
    </div>
  );
};
