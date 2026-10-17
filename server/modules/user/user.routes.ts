import express from 'express';

import type { createUserService } from './user.service.js';

type AuthenticatedRequest = express.Request & { user?: { id?: number | string } };

function readUserId(request: express.Request): number {
  const rawUserId = (request as AuthenticatedRequest).user?.id;
  return Number(rawUserId);
}

/** Creates thin user routes that parse authenticated input and call the service. */
export function createUserRouter(service: ReturnType<typeof createUserService>): express.Router {
  const router = express.Router();

  router.get('/git-config', async (req, res, next) => {
    try {
      res.json(await service.getGitConfig(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/git-config', async (req, res, next) => {
    try {
      const body = req.body as { gitName?: unknown; gitEmail?: unknown };
      res.json(await service.updateGitConfig(readUserId(req), body.gitName, body.gitEmail));
    } catch (error) {
      next(error);
    }
  });

  router.post('/complete-onboarding', (req, res, next) => {
    try {
      res.json(service.completeOnboarding(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/onboarding-status', (req, res, next) => {
    try {
      res.json(service.getOnboardingStatus(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.get('/preferences', (req, res, next) => {
    try {
      res.json(service.getPreferences(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  router.patch('/preferences', (req, res, next) => {
    try {
      res.json(service.savePreferences(readUserId(req), req.body));
    } catch (error) {
      next(error);
    }
  });

  router.get('/drafts', (req, res, next) => {
    try {
      res.json(service.getDrafts(readUserId(req)));
    } catch (error) {
      next(error);
    }
  });

  // The scope is a session id or `project:<id>`, so it is read from the body
  // rather than the path: neither form is guaranteed to be URL-path-safe.
  router.put('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.saveDraft(readUserId(req), body?.scope, req.body));
    } catch (error) {
      next(error);
    }
  });

  // A session's queue changes one message at a time, so a device that has not
  // yet seen the server send the oldest one cannot write it back.
  router.post('/drafts/queue', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown; message?: unknown };
      res.json(service.queueMessage(readUserId(req), body?.scope, body?.message));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts/queue', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown; id?: unknown };
      res.json(service.unqueueMessage(readUserId(req), body?.scope, body?.id));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/drafts', (req, res, next) => {
    try {
      const body = req.body as { scope?: unknown };
      res.json(service.deleteDraft(readUserId(req), body?.scope));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
