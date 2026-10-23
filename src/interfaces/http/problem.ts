import type { Response } from 'express';
import type { ValidationIssue } from '../../domain/errors.js';

/** RFC 7807 / RFC 9457 problem details. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: ValidationIssue[];
}

export const problemType = (code: string): string => `urn:content-sync-engine:problem:${code}`;

export function sendProblem(res: Response, problem: Problem): void {
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({ ...problem, requestId: res.locals.requestId as string | undefined });
}
