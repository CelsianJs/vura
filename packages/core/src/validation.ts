/**
 * ThenJS Input Validation — Optional Zod Integration
 *
 * Provides schema-based request validation for route handlers.
 * Uses Zod as a peer dependency — validation works with any Zod-compatible
 * schema, but doesn't require Zod at runtime if no schemas are declared.
 *
 * Usage:
 *   import { z } from 'zod';
 *   import { defineSchema, validate } from '@then/core';
 *
 *   export const schema = defineSchema({
 *     body: z.object({ name: z.string(), email: z.string().email() }),
 *     query: z.object({ page: z.coerce.number().optional() }),
 *     params: z.object({ id: z.string() }),
 *   });
 *
 *   // In handler: req.validated.body is typed { name: string; email: string }
 */

import type { ThenRequest, ThenReply } from './handler.js';

// ─── Types ───

/**
 * A Zod-compatible schema interface.
 * We don't import Zod directly — any object with .parse() and .safeParse()
 * methods will work. This keeps Zod as a true peer dependency.
 */
export interface ZodLikeSchema<T = unknown> {
  parse(data: unknown): T;
  safeParse(data: unknown): {
    success: boolean;
    data?: T;
    error?: {
      issues: Array<{
        path: Array<string | number>;
        message: string;
        code?: string;
      }>;
      message?: string;
    };
  };
}

/**
 * Schema definition for request validation.
 * Each field is optional — only declared schemas are validated.
 */
export interface RouteSchema<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  /** Schema for request body (POST, PUT, PATCH) */
  body?: ZodLikeSchema<TBody>;
  /** Schema for query string parameters */
  query?: ZodLikeSchema<TQuery>;
  /** Schema for route parameters */
  params?: ZodLikeSchema<TParams>;
}

/**
 * Validated request data — typed from schemas.
 */
export interface ValidatedData<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  body: TBody;
  query: TQuery;
  params: TParams;
}

/**
 * Validation error with structured details.
 */
export interface ValidationError {
  /** Which part of the request failed validation */
  target: 'body' | 'query' | 'params';
  /** Human-readable error messages */
  issues: Array<{
    path: string;
    message: string;
    code?: string;
  }>;
}

/**
 * Result of validation attempt.
 */
export interface ValidationResult<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  success: boolean;
  data?: ValidatedData<TBody, TQuery, TParams>;
  errors?: ValidationError[];
}

// ─── Public API ───

/**
 * Define a validation schema for a route handler.
 * Returns the schema object with proper typing for TypeScript inference.
 *
 * @example
 * ```ts
 * import { z } from 'zod';
 * import { defineSchema } from '@then/core';
 *
 * export const schema = defineSchema({
 *   body: z.object({
 *     name: z.string().min(1),
 *     email: z.string().email(),
 *   }),
 *   query: z.object({
 *     page: z.coerce.number().default(1),
 *   }),
 * });
 * ```
 */
export function defineSchema<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
>(
  schema: RouteSchema<TBody, TQuery, TParams>,
): RouteSchema<TBody, TQuery, TParams> {
  return schema;
}

/**
 * Validate a request against a schema definition.
 * Returns a result with typed validated data or structured errors.
 *
 * Called automatically by the framework when a route exports a `schema`.
 * Can also be called manually in handlers for custom validation flows.
 */
export function validate<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
>(
  req: ThenRequest,
  schema: RouteSchema<TBody, TQuery, TParams>,
): ValidationResult<TBody, TQuery, TParams> {
  const errors: ValidationError[] = [];
  let body: TBody = req.parsedBody as TBody;
  let query: TQuery = req.query as TQuery;
  let params: TParams = req.params as TParams;

  // Validate body
  if (schema.body) {
    const result = schema.body.safeParse(req.parsedBody);
    if (!result.success) {
      errors.push(formatError('body', result.error!));
    } else {
      body = result.data as TBody;
    }
  }

  // Validate query
  if (schema.query) {
    const result = schema.query.safeParse(req.query);
    if (!result.success) {
      errors.push(formatError('query', result.error!));
    } else {
      query = result.data as TQuery;
    }
  }

  // Validate params
  if (schema.params) {
    const result = schema.params.safeParse(req.params);
    if (!result.success) {
      errors.push(formatError('params', result.error!));
    } else {
      params = result.data as TParams;
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    data: { body, query, params },
  };
}

/**
 * Create middleware that validates requests and returns 400 on failure.
 * Attaches validated data to req.validated on success.
 *
 * @returns Handler wrapper that validates before calling the inner handler.
 */
export function withValidation<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
>(
  schema: RouteSchema<TBody, TQuery, TParams>,
  handler: (
    req: ThenRequest & { validated: ValidatedData<TBody, TQuery, TParams> },
    reply: ThenReply,
  ) => unknown | Promise<unknown>,
): (req: ThenRequest, reply: ThenReply) => unknown | Promise<unknown> {
  return (req: ThenRequest, reply: ThenReply) => {
    const result = validate(req, schema);
    if (!result.success) {
      return reply.status(400).json(formatValidationResponse(result.errors!));
    }

    // Attach validated data to request
    const validatedReq = req as ThenRequest & {
      validated: ValidatedData<TBody, TQuery, TParams>;
    };
    validatedReq.validated = result.data!;

    return handler(validatedReq, reply);
  };
}

/**
 * Validate a request and attach validated data, returning errors if validation fails.
 * Used internally by the framework's automatic validation.
 * Returns null on success (data attached to req), or an error response object on failure.
 */
export function validateRequest<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
>(
  req: ThenRequest,
  schema: RouteSchema<TBody, TQuery, TParams>,
): { statusCode: number; body: unknown } | null {
  const result = validate(req, schema);
  if (!result.success) {
    return {
      statusCode: 400,
      body: formatValidationResponse(result.errors!),
    };
  }

  // Attach validated data to request
  (req as any).validated = result.data;
  req.parsedBody = result.data!.body;
  req.body = result.data!.body;
  req.query = result.data!.query as Record<string, string>;
  req.params = result.data!.params as Record<string, string>;
  return null;
}

// ─── Internal ───

function formatError(
  target: ValidationError['target'],
  error: NonNullable<ReturnType<ZodLikeSchema['safeParse']>['error']>,
): ValidationError {
  return {
    target,
    issues: error.issues.map(issue => ({
      path: issue.path.join('.'),
      message: issue.message,
      ...(issue.code ? { code: issue.code } : {}),
    })),
  };
}

/**
 * Format validation errors into a client-friendly response.
 */
function formatValidationResponse(errors: ValidationError[]): {
  error: string;
  code: string;
  details: ValidationError[];
} {
  // Build a summary message
  const targets = errors.map(e => e.target);
  const issueCount = errors.reduce((acc, e) => acc + e.issues.length, 0);
  const message = `Validation failed: ${issueCount} issue${issueCount > 1 ? 's' : ''} in ${targets.join(', ')}`;

  return {
    error: message,
    code: 'VALIDATION_ERROR',
    details: errors,
  };
}
