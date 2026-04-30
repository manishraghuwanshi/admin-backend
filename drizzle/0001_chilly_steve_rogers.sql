CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(120) NOT NULL,
	"description" text,
	"logo_storage_key" text,
	"website_url" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_name_unique" UNIQUE("name"),
	CONSTRAINT "brands_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"low_stock_threshold" integer DEFAULT 5 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_product_id_unique" UNIQUE("product_id"),
	CONSTRAINT "inventory_quantity_non_negative_check" CHECK ("inventory"."quantity" >= 0),
	CONSTRAINT "inventory_reserved_quantity_non_negative_check" CHECK ("inventory"."reserved_quantity" >= 0),
	CONSTRAINT "inventory_low_stock_threshold_non_negative_check" CHECK ("inventory"."low_stock_threshold" >= 0),
	CONSTRAINT "inventory_reserved_not_greater_than_quantity_check" CHECK ("inventory"."reserved_quantity" <= "inventory"."quantity")
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"product_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "product_categories_pk" PRIMARY KEY("product_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"alt_text" varchar(255),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"watch_type" varchar(50),
	"movement" varchar(100),
	"case_material" varchar(100),
	"case_shape" varchar(50),
	"case_diameter" numeric(6, 2),
	"case_thickness" numeric(6, 2),
	"strap_material" varchar(100),
	"strap_color" varchar(50),
	"dial_color" varchar(50),
	"glass_material" varchar(100),
	"water_resistance" varchar(100),
	"power_reserve" varchar(100),
	"warranty_period" varchar(100),
	"gender" varchar(30),
	"additional_specifications" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_details_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT "products_category_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "image_storage_key" text;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "brand_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "sku" varchar(100) NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "short_description" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "price" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "compare_at_price" bigint;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "currency" varchar(3) DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "thumbnail_storage_key" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_featured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "watch_details" ADD CONSTRAINT "watch_details_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "brands_is_active_idx" ON "brands" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "brands_name_idx" ON "brands" USING btree ("name");--> statement-breakpoint
CREATE INDEX "inventory_product_id_idx" ON "inventory" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_categories_category_id_idx" ON "product_categories" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "product_images_product_id_idx" ON "product_images" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_images_sort_order_idx" ON "product_images" USING btree ("product_id","sort_order");--> statement-breakpoint
CREATE INDEX "watch_details_product_id_idx" ON "watch_details" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "categories_parent_id_idx" ON "categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "categories_is_active_idx" ON "categories" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "categories_sort_order_idx" ON "categories" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "products_brand_id_idx" ON "products" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "products_is_active_idx" ON "products" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "products_is_featured_idx" ON "products" USING btree ("is_featured");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("name");--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "category_id";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "price_in_paise";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN "stock_quantity";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_sku_unique" UNIQUE("sku");--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_price_non_negative_check" CHECK ("products"."price" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_compare_at_price_non_negative_check" CHECK ("products"."compare_at_price" IS NULL OR "products"."compare_at_price" >= 0);