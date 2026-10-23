import { Router } from 'express';

export interface ReadinessCheck {
  name: string;
  check: () => boolean;
}

export function healthRoutes(checks: readonly ReadinessCheck[], startedAt = Date.now()): Router {
  const router = Router();

  // Liveness: the process is up and the event loop is responsive. Never depends on I/O.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  // Readiness: safe to route traffic here (DB reachable, not shutting down).
  router.get('/ready', (_req, res) => {
    const results = Object.fromEntries(
      checks.map((c) => {
        let ok: boolean;
        try {
          ok = c.check();
        } catch {
          ok = false;
        }
        return [c.name, ok ? 'ok' : 'fail'];
      }),
    );
    const ready = Object.values(results).every((v) => v === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks: results });
  });

  return router;
}
