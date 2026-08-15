import { BadRequestException, Body, Controller, ForbiddenException, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { Throttle } from "@nestjs/throttler";
import { R2Service } from "./r2.service";

/**
 * Content types a browser may upload. An open `contentType` let a caller
 * presign `text/html` and serve stored HTML from the bucket's own origin —
 * stored XSS against whatever domain fronts R2. The list covers what the admin
 * actually uploads: product/batch images, chat attachments and spreadsheets.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  // Product images, batch photos, avatars, chat attachments.
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  // Documents and the bulk-import formats.
  "application/pdf",
  "text/csv",
  "text/plain",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
  // What the browser reports for a file whose type it cannot determine —
  // note attachments are arbitrary files, and this is what uploadFile() sends
  // for them. Safe by construction: browsers download it rather than render it,
  // which is the whole risk being managed here.
  "application/octet-stream",
]);

/** Matches the 15mb JSON cap in main.ts; R2 rejects anything larger at PUT time. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const presignSchema = z.object({
  fileName: z.string().min(1),
  contentType: z
    .string()
    .min(1)
    .refine((v) => ALLOWED_CONTENT_TYPES.has(v.toLowerCase()), {
      message: `Unsupported content type. Allowed: ${[...ALLOWED_CONTENT_TYPES].join(", ")}`,
    }),
  contentLength: z.number().int().positive().max(MAX_UPLOAD_BYTES).optional(),
  /** Folder hint: product-images | batch-photos | chat-attachments | excel | misc */
  kind: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("misc"),
});

const presignDownloadSchema = z.object({ key: z.string().min(1) });

@ApiTags("uploads")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
// Each call mints a signed URL against a third party; cheap for us, not free.
@Throttle({ default: { ttl: 60_000, limit: 60 } })
@Controller("api/:tenant/uploads")
export class UploadsController {
  constructor(private readonly r2: R2Service) {}

  /**
   * Returns a short-lived presigned PUT URL. The browser uploads directly to
   * R2 (no bytes through this API) and then saves `publicUrl` on the entity.
   */
  @Post("presign")
  @ApiOperation({
    summary: "Presign a direct upload to Cloudflare R2",
    description:
      "Body: { fileName, contentType, contentLength?, kind? }. PUT the file to uploadUrl, then save publicUrl on the entity.",
  })
  presign(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = presignSchema.parse(body);
    return this.r2.presignUpload(tenant.slug, input.fileName, input.contentType, input.kind, input.contentLength);
  }

  /**
   * Fresh read URL for a private object (when no public bucket domain is set).
   *
   * The key MUST live under this tenant's prefix. It previously did not: the
   * handler took no tenant at all and signed whatever key it was given, so any
   * authenticated user of any workspace could read another workspace's files by
   * asking for `othertenant/product-images/...`. Keys are minted as
   * `${tenantSlug}/${kind}/${uuid}-${name}` (R2Service.presignUpload), so the
   * prefix is the tenant boundary and checking it here restores it.
   */
  @Post("presign-download")
  @ApiOperation({
    summary: "Presign a fresh read URL for one of this tenant's private R2 objects",
    description: "Body: { key }. The key must start with this tenant's slug.",
  })
  presignDownload(
    @CurrentTenant() tenant: TenantDto,
    @Body() body: unknown,
    @Query("expiresIn") expiresIn?: string,
  ) {
    const { key } = presignDownloadSchema.parse(body);
    const prefix = `${tenant.slug}/`;
    // Reject traversal outright rather than trying to normalise it: "..%2f" and
    // friends are never legitimate in a key this API minted.
    if (key.includes("..") || !key.startsWith(prefix)) {
      throw new ForbiddenException("That file does not belong to this workspace");
    }

    const ttl = expiresIn ? Number.parseInt(expiresIn, 10) : undefined;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0 || ttl > 7 * 24 * 3600)) {
      throw new BadRequestException("expiresIn must be between 1 second and 7 days");
    }

    return this.r2.presignDownload(key, ttl).then((url) => ({ url }));
  }
}
