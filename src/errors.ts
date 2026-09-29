export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "CYCLIC_REF"
  | "MISSING_REF"
  | "BAD_DEPENDENCY"
  | "MUTEX_CONFLICT"
  | "BRANCH_LIMIT"
  | "DICT_MISMATCH"
  | "UNKNOWN_FEATURE"
  | "ANALYSIS_STALE";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function httpStatusFor(code: ErrorCode): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_ERROR":
      return 400;
    case "CONFLICT":
    case "ANALYSIS_STALE":
      return 409;
    case "CYCLIC_REF":
    case "MISSING_REF":
    case "BAD_DEPENDENCY":
    case "MUTEX_CONFLICT":
      return 422;
    case "BRANCH_LIMIT":
    case "DICT_MISMATCH":
    case "UNKNOWN_FEATURE":
      return 422;
    default:
      return 400;
  }
}
