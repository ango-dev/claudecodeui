import express from 'express';
import type { Request, Response } from 'express';

import type { createPromptPresetsService } from '@/modules/prompt-presets/prompt-presets.service.js';
import { AppError, createApiSuccessResponse } from '@/shared/utils.js';

type AuthenticatedRequest = Request & { user?: { id?: number | string } };

function readUserId(request: Request): number {
  const userId = Number((request as AuthenticatedRequest).user?.id);
  if (!Number.isInteger(userId)) {
    throw new AppError('Authenticated user is required.', {
      code: 'USER_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

function invalidField(field: string, expected: string): AppError {
  return new AppError(`${field} must be ${expected}.`, {
    code: 'INVALID_REQUEST_BODY',
    statusCode: 400,
  });
}

function readBody(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw invalidField(field, 'a string');
  }
  return value;
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidField(field, 'a string');
  }
  return value;
}

function readOptionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidField(field, 'a boolean');
  }
  return value;
}

/** The installed Express typings declare path params as `string | string[]`; `:id` is always one segment. */
function readPresetId(request: Request): string {
  const id = request.params.id;
  return typeof id === 'string' ? id : '';
}

/**
 * Wraps a synchronous handler so a thrown AppError reaches the app's error
 * middleware, which renders the `{ success: false, error }` envelope.
 */
function handle(handler: (req: Request, res: Response) => void): express.RequestHandler {
  return (req, res, next) => {
    try {
      handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Creates the thin `/api/prompt-presets` router: it checks transport types,
 * passes the authenticated user's id to the service, and wraps results in the
 * success envelope. Used by this module's wiring and by its route tests.
 */
export function createPromptPresetsRouter(
  service: ReturnType<typeof createPromptPresetsService>,
): express.Router {
  const router = express.Router();

  router.get('/', handle((req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    const presets = service.list(readUserId(req), projectId);
    res.json(createApiSuccessResponse({ presets }));
  }));

  router.post('/', handle((req, res) => {
    const body = readBody(req);
    const preset = service.create(readUserId(req), {
      projectId: readOptionalString(body, 'projectId'),
      title: readRequiredString(body, 'title'),
      content: readRequiredString(body, 'content'),
      global: readOptionalBoolean(body, 'global') ?? false,
    });
    res.status(201).json(createApiSuccessResponse({ preset }));
  }));

  router.patch('/:id', handle((req, res) => {
    const body = readBody(req);
    const preset = service.update(readUserId(req), readPresetId(req), {
      title: readOptionalString(body, 'title'),
      content: readOptionalString(body, 'content'),
      global: readOptionalBoolean(body, 'global'),
      projectId: readOptionalString(body, 'projectId'),
    });
    res.json(createApiSuccessResponse({ preset }));
  }));

  router.delete('/:id', handle((req, res) => {
    service.remove(readUserId(req), readPresetId(req));
    res.json(createApiSuccessResponse({ deleted: true }));
  }));

  router.post('/:id/use', handle((req, res) => {
    const preset = service.markUsed(readUserId(req), readPresetId(req));
    res.json(createApiSuccessResponse({ preset }));
  }));

  return router;
}
