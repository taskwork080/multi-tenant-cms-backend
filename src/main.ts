import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { PgExceptionFilter } from "./pg-exception.filter";
import { ZodExceptionFilter } from "./zod-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const origins = (process.env.CORS_ORIGIN ?? "http://localhost:5000").split(",").map((o) => o.trim());
  app.enableCors({ origin: origins, credentials: true });
  app.useGlobalFilters(new ZodExceptionFilter(), new PgExceptionFilter());
  app.enableShutdownHooks();

  // JSON bodies can carry base64 chat/note attachments; raise the default 100kb cap.
  app.use(json({ limit: "15mb" }));
  app.use(urlencoded({ extended: true, limit: "15mb" }));

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
