import type { ErrorCode } from '@group-chess/shared';

/** A business-rule failure; the HTTP and bot layers map `code` to a status or a one-line reply. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
