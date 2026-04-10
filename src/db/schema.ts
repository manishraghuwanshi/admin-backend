import { boolean, integer, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Categories
 */
export const categories = pgTable("categories", {
  id: uuid("id").defaultRandom().primaryKey(),

  name: varchar("name", {
    length: 100,
  }).notNull(),

  slug: varchar("slug", {
    length: 120,
  })
    .notNull()
    .unique(),

  description: text("description"),

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
});

/**
 * Products
 */
export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),

  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id),

  name: varchar("name", {
    length: 200,
  }).notNull(),

  slug: varchar("slug", {
    length: 220,
  })
    .notNull()
    .unique(),

  description: text("description"),

  priceInPaise: integer("price_in_paise").notNull(),

  stockQuantity: integer("stock_quantity").notNull().default(0),

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
});