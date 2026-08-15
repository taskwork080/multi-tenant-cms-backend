import { ArgumentsHost, Catch, ExceptionFilter, Logger } from "@nestjs/common";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { Response } from "express";

/** Shape of the postgres driver's error (code = SQLSTATE). */
interface PgError {
  code?: string;
  detail?: string;
  constraint_name?: string;
  column_name?: string;
}

/**
 * Maps Postgres constraint violations surfaced through Drizzle to meaningful
 * client errors instead of opaque 500s:
 *   23505 unique_violation      → 409 Conflict  (e.g. duplicate packing ref)
 *   23503 foreign_key_violation → 400 Bad Request (referenced row missing)
 *   23502 not_null_violation    → 400 Bad Request (required field missing)
 * Anything else stays a 500 (and is logged with the failing query).
 */
@Catch(DrizzleQueryError)
export class PgExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PgExceptionFilter.name);

  catch(exception: DrizzleQueryError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const pg = (exception.cause ?? {}) as PgError;

    switch (pg.code) {
      // `pg.detail` is deliberately logged, not returned: Postgres spells it
      // "Key (email)=(someone@example.com) already exists", which hands the
      // caller another tenant's column values and the constraint's internal
      // name. The constraint name alone is enough for a client to say which
      // field collided.
      case "23505":
        this.logger.warn(`unique_violation on ${pg.constraint_name ?? "?"}: ${pg.detail ?? exception.message}`);
        return res.status(409).json({
          statusCode: 409,
          error: "Conflict",
          message: "A record with the same unique value already exists",
          constraint: pg.constraint_name,
        });
      case "23503":
        this.logger.warn(`fk_violation on ${pg.constraint_name ?? "?"}: ${pg.detail ?? exception.message}`);
        return res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: "A referenced record does not exist",
          constraint: pg.constraint_name,
        });
      case "23502":
        return res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: pg.column_name ? `Required field "${pg.column_name}" is missing` : "A required field is missing",
        });
      default:
        this.logger.error(`Unhandled database error (${pg.code ?? "no code"}): ${exception.message}`);
        return res.status(500).json({
          statusCode: 500,
          error: "Internal Server Error",
          message: "Database query failed",
        });
    }
  }
}
