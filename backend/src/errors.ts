/**
 * Wire-level error catalogue.
 *
 * The codes and statuses are fixed by `docs/factory-api.md`. Messages stay
 * short, English and free of credentials or request bodies.
 */

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ErrorDefinition {
  readonly status: number;
  readonly body: ErrorBody;
}

function define(status: number, code: string, message: string): ErrorDefinition {
  return { status, body: { error: { code, message } } };
}

export const ERRORS = {
  unauthorized: define(401, 'UNAUTHORIZED', 'A valid bearer token is required.'),
  notFound: define(404, 'NOT_FOUND', 'The requested resource does not exist.'),
  methodNotAllowed: define(405, 'METHOD_NOT_ALLOWED', 'The method is not allowed for this route.'),
  requestIdReused: define(
    409,
    'REQUEST_ID_REUSED',
    'This requestId was already used with a different payload.',
  ),
  requestTooLarge: define(413, 'REQUEST_TOO_LARGE', 'The request body exceeds 8192 bytes.'),
  unsupportedMediaType: define(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'The production request must be application/json.',
  ),
  commandLimit: define(
    429,
    'COMMAND_LIMIT',
    'The match command acknowledgement limit was reached.',
  ),
  internal: define(500, 'INTERNAL_ERROR', 'The server failed to process the request.'),
} as const;

/** 400 helper: the contract keeps one code and lets the message name the cause. */
export function invalidRequest(message: string): ErrorDefinition {
  return define(400, 'INVALID_REQUEST', message);
}

export function forbidden(message: string): ErrorDefinition {
  return define(403, 'FORBIDDEN', message);
}

export const INVALID_REQUEST_MESSAGES = {
  malformedJson: 'The request body must be valid JSON.',
  shape: 'The request body must contain exactly requestId, lineId and recipeId.',
  requestId: 'The requestId must be 1-64 ASCII letters, digits, underscores or dashes.',
  unsupportedRecipe: 'Only recipe R1 is supported by this slice.',
} as const;

export const FORBIDDEN_MESSAGES = {
  lineNotOwned: 'The production line is not owned by the authenticated company.',
} as const;
