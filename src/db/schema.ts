import { relations, sql } from "drizzle-orm";

import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Brands
 */
export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    name: varchar("name", {
      length: 100,
    })
      .notNull()
      .unique(),

    slug: varchar("slug", {
      length: 120,
    })
      .notNull()
      .unique(),

    description: text("description"),

    logoStorageKey: text("logo_storage_key"),

    websiteUrl: text("website_url"),

    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("brands_is_active_idx").on(table.isActive),
    index("brands_name_idx").on(table.name),
  ],
);

/**
 * Categories
 *
 * parentId supports nested categories.
 *
 * Example:
 * Watches
 * ├── Men's Watches
 * ├── Women's Watches
 * └── Smart Watches
 *
 * The self-referencing foreign-key constraint is intentionally
 * not defined here to avoid TypeScript circular-initialization
 * errors.
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    parentId: uuid("parent_id"),

    name: varchar("name", {
      length: 100,
    }).notNull(),

    slug: varchar("slug", {
      length: 120,
    })
      .notNull()
      .unique(),

    description: text("description"),

    imageStorageKey: text("image_storage_key"),

    isActive: boolean("is_active").notNull().default(true),

    sortOrder: integer("sort_order").notNull().default(0),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("categories_parent_id_idx").on(table.parentId),

    index("categories_is_active_idx").on(table.isActive),

    index("categories_sort_order_idx").on(table.sortOrder),
  ],
);

/**
 * Products
 */
export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, {
        onDelete: "restrict",
        onUpdate: "cascade",
      }),

    name: varchar("name", {
      length: 200,
    }).notNull(),

    slug: varchar("slug", {
      length: 220,
    })
      .notNull()
      .unique(),

    sku: varchar("sku", {
      length: 100,
    })
      .notNull()
      .unique(),

    shortDescription: text("short_description"),

    description: text("description"),

    price: bigint("price", {
      mode: "number",
    }).notNull(),

    compareAtPrice: bigint("compare_at_price", {
      mode: "number",
    }),

    currency: varchar("currency", {
      length: 3,
    })
      .notNull()
      .default("INR"),

    thumbnailStorageKey: text("thumbnail_storage_key"),

    isFeatured: boolean("is_featured").notNull().default(false),

    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("products_brand_id_idx").on(table.brandId),

    index("products_is_active_idx").on(table.isActive),

    index("products_is_featured_idx").on(table.isFeatured),

    index("products_name_idx").on(table.name),

    check(
      "products_price_non_negative_check",
      sql`${table.price} >= 0`,
    ),

    check(
      "products_compare_at_price_non_negative_check",
      sql`${table.compareAtPrice} IS NULL OR ${table.compareAtPrice} >= 0`,
    ),
  ],
);

/**
 * Product-category many-to-many relationship
 */
export const productCategories = pgTable(
  "product_categories",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),

    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
  },
  (table) => [
    primaryKey({
      columns: [table.productId, table.categoryId],
      name: "product_categories_pk",
    }),

    index("product_categories_category_id_idx").on(table.categoryId),
  ],
);

/**
 * Watch-specific details
 */
export const watchDetails = pgTable(
  "watch_details",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    productId: uuid("product_id")
      .notNull()
      .unique()
      .references(() => products.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),

    watchType: varchar("watch_type", {
      length: 50,
    }),

    movement: varchar("movement", {
      length: 100,
    }),

    caseMaterial: varchar("case_material", {
      length: 100,
    }),

    caseShape: varchar("case_shape", {
      length: 50,
    }),

    caseDiameter: numeric("case_diameter", {
      precision: 6,
      scale: 2,
    }),

    caseThickness: numeric("case_thickness", {
      precision: 6,
      scale: 2,
    }),

    strapMaterial: varchar("strap_material", {
      length: 100,
    }),

    strapColor: varchar("strap_color", {
      length: 50,
    }),

    dialColor: varchar("dial_color", {
      length: 50,
    }),

    glassMaterial: varchar("glass_material", {
      length: 100,
    }),

    waterResistance: varchar("water_resistance", {
      length: 100,
    }),

    powerReserve: varchar("power_reserve", {
      length: 100,
    }),

    warrantyPeriod: varchar("warranty_period", {
      length: 100,
    }),

    gender: varchar("gender", {
      length: 30,
    }),

    additionalSpecifications: jsonb("additional_specifications"),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("watch_details_product_id_idx").on(table.productId),
  ],
);

/**
 * Product images
 */
export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),

    storageKey: text("storage_key").notNull(),

    altText: varchar("alt_text", {
      length: 255,
    }),

    sortOrder: integer("sort_order").notNull().default(0),

    isPrimary: boolean("is_primary").notNull().default(false),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("product_images_product_id_idx").on(table.productId),

    index("product_images_sort_order_idx").on(
      table.productId,
      table.sortOrder,
    ),
  ],
);

/**
 * Inventory
 */
export const inventory = pgTable(
  "inventory",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    productId: uuid("product_id")
      .notNull()
      .unique()
      .references(() => products.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),

    quantity: integer("quantity").notNull().default(0),

    reservedQuantity: integer("reserved_quantity")
      .notNull()
      .default(0),

    lowStockThreshold: integer("low_stock_threshold")
      .notNull()
      .default(5),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("inventory_product_id_idx").on(table.productId),

    check(
      "inventory_quantity_non_negative_check",
      sql`${table.quantity} >= 0`,
    ),

    check(
      "inventory_reserved_quantity_non_negative_check",
      sql`${table.reservedQuantity} >= 0`,
    ),

    check(
      "inventory_low_stock_threshold_non_negative_check",
      sql`${table.lowStockThreshold} >= 0`,
    ),

    check(
      "inventory_reserved_not_greater_than_quantity_check",
      sql`${table.reservedQuantity} <= ${table.quantity}`,
    ),
  ],
);

export const brandsRelations = relations(brands, ({ many }) => ({
  products: many(products),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  productCategories: many(productCategories),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  brand: one(brands, {
    fields: [products.brandId],
    references: [brands.id],
  }),
  productCategories: many(productCategories),
  watchDetails: one(watchDetails, {
    fields: [products.id],
    references: [watchDetails.productId],
  }),
  images: many(productImages),
  inventory: one(inventory, {
    fields: [products.id],
    references: [inventory.productId],
  }),
}));

export const productCategoriesRelations = relations(productCategories, ({ one }) => ({
  product: one(products, {
    fields: [productCategories.productId],
    references: [products.id],
  }),
  category: one(categories, {
    fields: [productCategories.categoryId],
    references: [categories.id],
  }),
}));

export const watchDetailsRelations = relations(watchDetails, ({ one }) => ({
  product: one(products, {
    fields: [watchDetails.productId],
    references: [products.id],
  }),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, {
    fields: [productImages.productId],
    references: [products.id],
  }),
}));

export const inventoryRelations = relations(inventory, ({ one }) => ({
  product: one(products, {
    fields: [inventory.productId],
    references: [products.id],
  }),
}));

