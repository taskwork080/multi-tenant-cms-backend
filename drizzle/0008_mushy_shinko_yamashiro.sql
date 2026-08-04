CREATE TABLE "storefront_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"custom_domain" text,
	"theme" jsonb DEFAULT '{"brand":"#2563eb","brandFg":"#ffffff","accent":"#f59e0b","bg":"#ffffff","fg":"#0f172a","muted":"#64748b","fontHeading":"Space Grotesk","fontBody":"Schibsted Grotesk","radius":12,"logoUrl":null,"faviconUrl":null}'::jsonb NOT NULL,
	"seo" jsonb DEFAULT '{"title":"","description":"","keywords":[],"ogImageUrl":null,"twitterHandle":null,"robots":"index,follow"}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_navigation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location" text DEFAULT 'header' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storefront_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"slug" text NOT NULL,
	"content_blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storefront_configs" ADD CONSTRAINT "storefront_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_navigation" ADD CONSTRAINT "storefront_navigation_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefront_pages" ADD CONSTRAINT "storefront_pages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_configs_tenant" ON "storefront_configs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_configs_domain" ON "storefront_configs" USING btree ("custom_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_navigation_tenant_location" ON "storefront_navigation" USING btree ("tenant_id","location");--> statement-breakpoint
CREATE INDEX "storefront_pages_tenant_idx" ON "storefront_pages" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storefront_pages_tenant_slug" ON "storefront_pages" USING btree ("tenant_id","slug");