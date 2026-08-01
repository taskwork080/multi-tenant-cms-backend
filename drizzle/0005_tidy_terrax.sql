CREATE TABLE "cycle_count_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sku_code" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"expected_qty" integer DEFAULT 0 NOT NULL,
	"counted_qty" integer,
	"variance" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"warehouse_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"scope" text DEFAULT 'manual' NOT NULL,
	"counted_by" text DEFAULT '' NOT NULL,
	"posted_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_receipt_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sku_code" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"unit_cost" numeric(12, 2),
	"expiry_date" text,
	"batch_ref" text,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"warehouse_name" text DEFAULT '' NOT NULL,
	"supplier_name" text DEFAULT '' NOT NULL,
	"manufacturer_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"received_at" timestamp with time zone,
	"reference_no" text,
	"photo_url" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"incoming" integer DEFAULT 0 NOT NULL,
	"bin_location" text,
	"low_stock_threshold" integer,
	"sku_code" text DEFAULT '' NOT NULL,
	"sku_name" text DEFAULT '' NOT NULL,
	"warehouse_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"order_id" uuid,
	"order_item_id" uuid,
	"order_code" text DEFAULT '' NOT NULL,
	"sku_code" text DEFAULT '' NOT NULL,
	"sku_name" text DEFAULT '' NOT NULL,
	"warehouse_name" text DEFAULT '' NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"fulfilled_qty" integer DEFAULT 0 NOT NULL,
	"released_qty" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"code" text NOT NULL,
	"barcode" text,
	"name" text DEFAULT '' NOT NULL,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"low_stock_threshold" integer DEFAULT 10 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"kind" text NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"reserved_delta" integer DEFAULT 0 NOT NULL,
	"on_hand_after" integer DEFAULT 0 NOT NULL,
	"reserved_after" integer DEFAULT 0 NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"ref_code" text,
	"reason" text,
	"note" text,
	"actor" text DEFAULT 'system' NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"sku_code" text DEFAULT '' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"received_qty" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"from_warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid NOT NULL,
	"from_warehouse_name" text DEFAULT '' NOT NULL,
	"to_warehouse_name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"dispatched_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"carrier" text,
	"tracking_ref" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "sku_id" uuid;--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "packing_items" ADD COLUMN "sku_id" uuid;--> statement-breakpoint
ALTER TABLE "packing_items" ADD COLUMN "qty" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD COLUMN "sku_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD COLUMN "sku_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD COLUMN "inventory_level_id" uuid;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_count_id_cycle_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_items" ADD CONSTRAINT "cycle_count_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt_items" ADD CONSTRAINT "inbound_receipt_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt_items" ADD CONSTRAINT "inbound_receipt_items_receipt_id_inbound_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."inbound_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipt_items" ADD CONSTRAINT "inbound_receipt_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_receipts" ADD CONSTRAINT "inbound_receipts_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_reservations" ADD CONSTRAINT "inventory_reservations_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cycle_count_items_count_idx" ON "cycle_count_items" USING btree ("count_id");--> statement-breakpoint
CREATE INDEX "cycle_counts_tenant_idx" ON "cycle_counts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "cycle_counts_tenant_status_idx" ON "cycle_counts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_counts_tenant_ref" ON "cycle_counts" USING btree ("tenant_id","ref");--> statement-breakpoint
CREATE INDEX "inbound_receipt_items_receipt_idx" ON "inbound_receipt_items" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "inbound_receipts_tenant_idx" ON "inbound_receipts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inbound_receipts_tenant_status_idx" ON "inbound_receipts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_receipts_tenant_ref" ON "inbound_receipts" USING btree ("tenant_id","ref");--> statement-breakpoint
CREATE INDEX "inventory_levels_tenant_idx" ON "inventory_levels" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inventory_levels_warehouse_idx" ON "inventory_levels" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_levels_sku_wh" ON "inventory_levels" USING btree ("tenant_id","sku_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_tenant_idx" ON "inventory_reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_order_idx" ON "inventory_reservations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_reservations_sku_idx" ON "inventory_reservations" USING btree ("tenant_id","sku_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_reservations_item" ON "inventory_reservations" USING btree ("order_item_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "skus_tenant_idx" ON "skus" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "skus_tenant_created_idx" ON "skus" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "skus_product_idx" ON "skus" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_tenant_code" ON "skus" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "skus_tenant_variant" ON "skus" USING btree ("tenant_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_movements_tenant_at_idx" ON "stock_movements" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "stock_movements_sku_at_idx" ON "stock_movements" USING btree ("tenant_id","sku_id","at");--> statement-breakpoint
CREATE INDEX "stock_movements_ref_idx" ON "stock_movements" USING btree ("tenant_id","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_items_transfer_idx" ON "stock_transfer_items" USING btree ("transfer_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_tenant_idx" ON "stock_transfers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_tenant_status_idx" ON "stock_transfers" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_tenant_ref" ON "stock_transfers" USING btree ("tenant_id","ref");--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packing_items" ADD CONSTRAINT "packing_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_items" ADD CONSTRAINT "shipment_items_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_inventory_level_id_inventory_levels_id_fk" FOREIGN KEY ("inventory_level_id") REFERENCES "public"."inventory_levels"("id") ON DELETE set null ON UPDATE no action;