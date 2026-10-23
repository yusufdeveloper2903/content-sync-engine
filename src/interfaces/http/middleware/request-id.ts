import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_ID = /^[\w.:-]{1,128}$/;

/** Propagates a caller-supplied X-Request-Id (if well-formed) or generates one. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get(REQUEST_ID_HEADER);
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};
