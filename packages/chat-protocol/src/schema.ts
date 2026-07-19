export type ProtocolValidationPathSegment = string | number;

export interface ProtocolValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly ProtocolValidationPathSegment[];
}

export type ProtocolParseResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly error: ProtocolValidationError;
    };

/**
 * Stable validation surface exported by the protocol package.
 *
 * The implementation intentionally exposes only parse and safeParse so the
 * selected schema library does not become part of the public API contract.
 */
export interface RuntimeSchema<T> {
  parse(input: unknown): T;
  safeParse(input: unknown): ProtocolParseResult<T>;
}

export class ProtocolValidationError extends Error {
  readonly issues: readonly ProtocolValidationIssue[];

  constructor(issues: readonly ProtocolValidationIssue[]) {
    super(
      issues.length === 0
        ? "Protocol validation failed"
        : `Protocol validation failed: ${issues[0]!.message}`,
    );
    this.name = "ProtocolValidationError";
    this.issues = Object.freeze([...issues]);
  }
}
