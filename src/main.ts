import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, urlencoded } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { PgExceptionFilter } from "./pg-exception.filter";
import { StorefrontService } from "./storefront/storefront.service";
import { ZodExceptionFilter } from "./zod-exception.filter";
import { docsEnabled } from "./config/env.validation";

async function bootstrap() {
  // AUTH_DEV_BYPASS grants platform_admin to any caller with no Bearer token.
  // With /api/admin/* live that is a total compromise, so refuse to start
  // rather than trust that nobody copied the wrong .env onto a server.
  if (process.env.NODE_ENV === "production" && process.env.AUTH_DEV_BYPASS === "true") {
    throw new Error("AUTH_DEV_BYPASS must not be enabled in production — it grants platform_admin to anonymous callers");
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  if (process.env.AUTH_DEV_BYPASS === "true") {
    new Logger("Bootstrap").warn("AUTH_DEV_BYPASS is ON — unauthenticated requests act as platform_admin");
  }

  // Express 5 defaults the query parser to "simple" (Node's querystring), which
  // leaves `?createdAt[gte]=…` as the literal key "createdAt[gte]". The CRUD
  // list endpoint's range filters need the qs-based parser to see it as a
  // nested object. Flat keys parse identically either way, so this is additive.
  app.set("query parser", "extended");

  // The admin's origins are known at boot; a tenant's storefront domain is not
  // — tenants add custom domains at runtime, and a storefront whose checkout is
  // blocked by CORS is a storefront that cannot take an order. So the static
  // list is checked first and StorefrontService decides the rest, on exactly
  // the terms it serves the storefront itself (live tenant, module entitled).
  //
  // A missing Origin (server-to-server, curl, same-origin) is allowed through:
  // CORS only ever governs browsers.
  const origins = (process.env.CORS_ORIGIN ?? "http://localhost:5000").split(",").map((o) => o.trim());
  const storefront = app.get(StorefrontService, { strict: false });
  app.enableCors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin || origins.includes(origin)) return callback(null, true);
      storefront
        .isLiveOrigin(origin)
        .then((allowed) => callback(null, allowed))
        .catch(() => callback(null, false));
    },
  });
  // This is a JSON API with no server-rendered HTML of its own, so the default
  // helmet set applies cleanly. CSP is left off: the only HTML served is
  // Swagger's, which needs inline scripts, and it is gated below.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.useGlobalFilters(new ZodExceptionFilter(), new PgExceptionFilter());
  app.enableShutdownHooks();

  // Rate limiting keys off the client IP, so behind a load balancer every
  // request otherwise looks like it comes from the proxy. Without this the
  // per-route limits on the public storefront are effectively global.
  app.set("trust proxy", 1);

  // JSON bodies can carry base64 chat/note attachments; raise the default 100kb cap.
  app.use(json({ limit: "15mb" }));
  app.use(urlencoded({ extended: true, limit: "15mb" }));

  // Swagger is unauthenticated by construction — it has to be reachable before
  // you have a token. That is fine in development and an inventory of every
  // route and payload shape in production, so it is off there unless someone
  // opts in with ENABLE_DOCS=true.
  if (!docsEnabled({ NODE_ENV: process.env.NODE_ENV ?? "development", ENABLE_DOCS: process.env.ENABLE_DOCS })) {
    const port = parseInt(process.env.PORT ?? "4000", 10);
    await app.listen(port);
    new Logger("Bootstrap").log(`API listening on http://localhost:${port} (health: /health, docs disabled)`);
    return;
  }

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Multi-Tenant CMS API")
    .setDescription(
      "NestJS backend for the multi-tenant CMS admin. All business routes follow " +
        "`/api/{tenant}/{resource}` where `{tenant}` is the tenant slug and payload " +
        "shapes match the frontend's `src/lib/types.ts`. Authenticate with a Supabase " +
        "Auth access token (Bearer); the token's `app_metadata.tenant_id` must match the tenant.",
    )
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, swaggerConfig), {
    customSiteTitle: "Multi-Tenant CMS API Docs",
    swaggerOptions: { persistAuthorization: true },
  });

  const port = parseInt(process.env.PORT ?? "4000", 10);
  await app.listen(port);
  new Logger("Bootstrap").log(`API listening on http://localhost:${port} (health: /health, docs: /docs)`);
}

bootstrap();
