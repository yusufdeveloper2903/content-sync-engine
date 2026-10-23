import type { ErrorRequestHandler, RequestHandler } from 'express';
import {
  ConflictError,
  IdempotencyKeyReuseError,
  DomainError,
  NotFoundError,
  ValidationError,
} from '../../../domain/errors.js';
import type { Logger } from '../../../shared/logger.js';
import { problemType, sendProblem } from '../problem.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  sendProblem(res, {
    type: problemType('route-not-found'),
    title: 'Not Found',
    status: 404,
    detail: `No route for ${req.method} ${req.path}`,
    instance: req.originalUrl,
  });
};

interface HttpLikeError {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
  message: string;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const instance = req.originalUrl;

    if (err instanceof ValidationError) {
      return sendProblem(res, {
        type: problemType('validation-error'),
        title: 'Validation Failed',
        status: 400,
        detail: err.message,
        instance,
        errors: err.issues,
      });
    }
    if (err instanceof NotFoundError) {
      return sendProblem(res, {
        type: problemType('not-found'),
        title: 'Not Found',
        status: 404,
        detail: err.message,
        instance,
      });
    }
    if (err instanceof IdempotencyKeyReuseError) {
      // Per draft-ietf-httpapi-idempotency-key-header: same key, different payload -> 422.
      return sendProblem(res, {
        type: problemType('idempotency-key-reused'),
        title: 'Idempotency Key Reused',
        status: 422,
        detail: err.message,
        instance,
      });
    }
    if (err instanceof ConflictError) {
      return sendProblem(res, {
        type: problemType('conflict'),
        title: 'Conflict',
        status: 409,
        detail: err.message,
        instance,
      });
    }

    // Errors raised by body-parser & co. carry a 4xx status and are safe to expose.
    const httpErr = err as Partial<HttpLikeError> | undefined;
    const status = httpErr?.status ?? httpErr?.statusCode;
    if (status && status >= 400 && status < 500 && !(err instanceof DomainError)) {
      return sendProblem(res, {
        type: problemType(
          httpErr?.type === 'entity.parse.failed' ? 'malformed-json' : 'bad-request',
        ),
        title: httpErr?.type === 'entity.parse.failed' ? 'Malformed JSON body' : 'Bad Request',
        status,
        detail: httpErr?.expose ? httpErr.message : undefined,
        instance,
      });
    }

    logger.error({ err, requestId: res.locals.requestId as string }, 'unhandled error');
    return sendProblem(res, {
      type: problemType('internal'),
      title: 'Internal Server Error',
      status: 500,
      detail: 'An unexpected error occurred',
      instance,
    });
  };
}
