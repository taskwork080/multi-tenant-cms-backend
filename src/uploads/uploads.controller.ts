import { Body, Controller, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { R2Service } from "./r2.service";

const presignSchema = z.object({
  fileName: z.string().min(1),
  contentType: z.string().min(1),
  /** Folder hint: product-images | batch-photos | chat-attachments | excel | misc */
  kind: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default("misc"),
});

@ApiTags("uploads")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/uploads")
@UseGuards(TenantGuard)
export class UploadsController {
  constructor(private readonly r2: R2Service) {}

  /**
   * Returns a short-lived presigned PUT URL. The browser uploads directly to
   * R2 (no bytes through this API) and then saves `publicUrl` on the entity.
   */
  @Post("presign")
  @ApiOperation({
    summary: "Presign a direct upload to Cloudflare R2",
    description: "Body: { fileName, contentType, kind? }. PUT the file to uploadUrl, then save publicUrl on the entity.",
  })
  presign(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = presignSchema.parse(body);
    return this.r2.presignUpload(tenant.slug, input.fileName, input.contentType, input.kind);
  }

  /** Fresh read URL for a private object (when no public bucket domain is set). */
  @Post("presign-download")
  @ApiOperation({ summary: "Presign a fresh read URL for a private R2 object", description: "Body: { key }" })
  presignDownload(@Body() body: { key: string }, @Query("expiresIn") expiresIn?: string) {
    const schema = z.object({ key: z.string().min(1) });
    const { key } = schema.parse(body);
    return this.r2.presignDownload(key, expiresIn ? parseInt(expiresIn, 10) : undefined).then((url) => ({ url }));
  }
}
