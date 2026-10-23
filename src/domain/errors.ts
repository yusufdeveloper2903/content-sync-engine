/**
 * Domain-level errors. The HTTP layer maps these onto RFC 7807 problem responses;
 * nothing in here knows about HTTP.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found';
}

export class ConflictError extends DomainError {
  readonly code = 'conflict';
}

/** An idempotency key was reused with a different request body. */
export class IdempotencyKeyReuseError extends DomainError {
  readonly code = 'idempotency_key_reused';
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export class ValidationError extends DomainError {
  readonly code = 'validation_error';

  constructor(
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
  }
}

/** Thrown by upstream adapters; `retryable` tells the queue whether another attempt makes sense. */
export class UpstreamError extends DomainError {
  readonly code = 'upstream_error';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** A failure that must not be retried (bad payload, unknown job type, ...). */
export class PermanentJobError extends DomainError {
  readonly code = 'permanent_job_error';
}
