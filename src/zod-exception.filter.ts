import { ArgumentsHost, Catch, ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ZodError } from "zod";

/** Maps zod validation failures to a clean 400 instead of a 500. */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(400).json({
      statusCode: 400,
      error: "Bad Request",
      message: "Validation failed",
      issues: exception.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
}
