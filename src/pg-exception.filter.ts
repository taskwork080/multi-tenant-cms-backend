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
      case "23505":
        return res.status(409).json({
          statusCode: 409,
          error: "Conflict",
          message: pg.detail ?? "A record with the same unique value already exists",
        });
      case "23503":
        return res.status(400).json({
          statusCode: 400,
          error: "Bad Request",
          message: pg.detail ?? "A referenced record does not exist",
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
