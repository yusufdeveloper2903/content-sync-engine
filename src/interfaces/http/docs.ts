import { readFileSync } from 'node:fs';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';

/** openapi.yaml lives at the repo root; this path resolves from both src/ and dist/. */
const SPEC_URL = new URL('../../../openapi.yaml', import.meta.url);

export function loadOpenApiSpec(): Record<string, unknown> {
  return parse(readFileSync(SPEC_URL, 'utf8')) as Record<string, unknown>;
}

export function docsRoutes(): Router {
  const spec = loadOpenApiSpec();
  const router = Router();
  router.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });
  router.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, { customSiteTitle: 'Content Sync Engine API' }),
  );
  return router;
}
