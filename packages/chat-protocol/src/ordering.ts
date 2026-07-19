interface OrderedAgentEventTransition {
  readonly id: string;
  readonly occurredAt: number;
  readonly sequence?: number | undefined;
}

/** Total ordering used after idempotent transition upsert by transition.id. */
export const compareAgentEventTransitions = (
  left: OrderedAgentEventTransition,
  right: OrderedAgentEventTransition,
): number => {
  const timestampOrder = left.occurredAt - right.occurredAt;
  if (timestampOrder !== 0) return timestampOrder;

  const sequenceOrder =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) -
    (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (sequenceOrder !== 0) return sequenceOrder;

  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};
