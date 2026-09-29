/**
 * Explicit, machine-readable error codes returned by both the API and CLI.
 */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  APPLICATION_NOT_FOUND: 'APPLICATION_NOT_FOUND',
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',
  DICTIONARY_NOT_FOUND: 'DICTIONARY_NOT_FOUND',
  ANALYSIS_NOT_FOUND: 'ANALYSIS_NOT_FOUND',
  REVIEW_NOT_FOUND: 'REVIEW_NOT_FOUND',
  CLAIM_CYCLE: 'CLAIM_CYCLE',
  MISSING_CITATION: 'MISSING_CITATION',
  MUTEX_CONFLICT: 'MUTEX_CONFLICT',
  UNKNOWN_CLAIM_FEATURE: 'UNKNOWN_CLAIM_FEATURE',
  UNKNOWN_DICTIONARY_FEATURE: 'UNKNOWN_DICTIONARY_FEATURE',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_SCOPE: 'INVALID_SCOPE',
  ANALYSIS_BLOCKED: 'ANALYSIS_BLOCKED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = 'AppError';
  }
}
