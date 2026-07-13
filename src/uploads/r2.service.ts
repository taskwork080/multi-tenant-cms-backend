import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

export interface PresignResult {
  key: string;
  /** PUT the file bytes here (with the same Content-Type). */
  uploadUrl: string;
  /** Public CDN URL to store on the entity (imageUrl / photoUrl / attachmentUrl). */
  publicUrl: string;
  expiresIn: number;
}

/** Cloudflare R2 via its S3-compatible API — zero-egress storage for images + Excel. */
@Injectable()
export class R2Service {
  private client?: S3Client;
  private bucket: string;
  private publicBase: string;

  constructor(private readonly config: ConfigService) {
    const accountId = this.config.get<string>("R2_ACCOUNT_ID");
    const accessKeyId = this.config.get<string>("R2_ACCESS_KEY_ID");
    const secretAccessKey = this.config.get<string>("R2_SECRET_ACCESS_KEY");
    this.bucket = this.config.get<string>("R2_BUCKET") ?? "cms-assets";
    this.publicBase = (this.config.get<string>("R2_PUBLIC_URL") ?? "").replace(/\/$/, "");

    if (accountId && accessKeyId && secretAccessKey) {
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
      });
    }
  }

  private ensure(): S3Client {
    if (!this.client) {
      throw new ServiceUnavailableException(
        "R2 is not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY",
      );
    }
    return this.client;
  }

  async presignUpload(tenantSlug: string, fileName: string, contentType: string, kind = "misc"): Promise<PresignResult> {
    const client = this.ensure();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${tenantSlug}/${kind}/${randomUUID()}-${safeName}`;
    const expiresIn = 600;

    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn },
    );

    const publicUrl = this.publicBase ? `${this.publicBase}/${key}` : await this.presignDownload(key, 7 * 24 * 3600);
    return { key, uploadUrl, publicUrl, expiresIn };
  }

  async presignDownload(key: string, expiresIn = 3600): Promise<string> {
    const client = this.ensure();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }
}
