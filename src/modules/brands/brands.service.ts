import { and, asc, count, desc, eq, ilike, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import { brands, products } from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { conflict, notFound } from "../../utils/errors.js";
import { sendPaginated, sendSuccess } from "../../utils/http.js";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "../../utils/pagination.js";
import { optionalBooleanQuery, slugSchema, uuidParamSchema } from "../../utils/schemas.js";

export const brandListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  isActive: optionalBooleanQuery,
  sort: z.enum(["name", "createdAt", "updatedAt"]).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export const brandBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: slugSchema.max(120),
  description: z.string().trim().max(5000).nullable().optional(),
  logoStorageKey: z.string().trim().max(500).nullable().optional(),
  websiteUrl: z.union([z.url(), z.literal(""), z.null()]).optional(),
  isActive: z.boolean().optional(),
});

export const brandUpdateSchema = brandBodySchema.partial();

function listFilters(query: z.infer<typeof brandListQuerySchema>): SQL | undefined {
  const filters: SQL[] = [];

  if (query.search) {
    filters.push(ilike(brands.name, `%${query.search}%`));
  }

  if (query.isActive !== undefined) {
    filters.push(eq(brands.isActive, query.isActive));
  }

  if (filters.length === 0) {
    return undefined;
  }

  return and(...filters);
}

export async function listBrands(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof brandListQuerySchema>;
  const where = listFilters(query);
  const sortColumn = {
    name: brands.name,
    createdAt: brands.createdAt,
    updatedAt: brands.updatedAt,
  }[query.sort];

  // `name` is unique, so it is a safe final tie-break for the timestamp sorts.
  // Without one, two brands sharing a `createdAt` can repeat or vanish across pages.
  const orderBy =
    query.order === "asc" ? [asc(sortColumn), asc(brands.name)] : [desc(sortColumn), asc(brands.name)];

  const [{ total }] = await db.select({ total: count() }).from(brands).where(where);
  const rows = await db
    .select()
    .from(brands)
    .where(where)
    .orderBy(...orderBy)
    .limit(query.limit)
    .offset(paginationOffset(query.page, query.limit));

  sendPaginated(res, rows, paginationMeta(query.page, query.limit, Number(total)));
}

export async function getBrand(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const [row] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);

  if (!row) {
    throw notFound("Brand not found");
  }

  sendSuccess(res, row);
}

export async function createBrand(req: Request, res: Response): Promise<void> {
  const body = req.validatedBody as z.infer<typeof brandBodySchema>;
  const websiteUrl = body.websiteUrl === "" ? null : (body.websiteUrl ?? null);

  const [created] = await db
    .insert(brands)
    .values({
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      logoStorageKey: body.logoStorageKey ?? null,
      websiteUrl,
      isActive: body.isActive ?? true,
    })
    .returning();

  await recordAudit({
    actorId: req.authUser?.id,
    action: "brand.create",
    entityType: "brand",
    entityId: created.id,
    metadata: { slug: created.slug },
    req,
  });

  sendSuccess(res, created, 201);
}

export async function updateBrand(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const body = req.validatedBody as z.infer<typeof brandUpdateSchema>;

  const [existing] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);

  if (!existing) {
    throw notFound("Brand not found");
  }

  const [updated] = await db
    .update(brands)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.logoStorageKey !== undefined ? { logoStorageKey: body.logoStorageKey } : {}),
      ...(body.websiteUrl !== undefined
        ? { websiteUrl: body.websiteUrl === "" ? null : body.websiteUrl }
        : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      updatedAt: new Date(),
    })
    .where(eq(brands.id, id))
    .returning();

  await recordAudit({
    actorId: req.authUser?.id,
    action: "brand.update",
    entityType: "brand",
    entityId: id,
    req,
  });

  sendSuccess(res, updated);
}

export async function deleteBrand(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const [existing] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);

  if (!existing) {
    throw notFound("Brand not found");
  }

  const [{ productCount }] = await db
    .select({ productCount: count() })
    .from(products)
    .where(eq(products.brandId, id));

  if (Number(productCount) > 0) {
    throw conflict("Cannot delete a brand that still has products");
  }

  await db.delete(brands).where(eq(brands.id, id));

  await recordAudit({
    actorId: req.authUser?.id,
    action: "brand.delete",
    entityType: "brand",
    entityId: id,
    metadata: { slug: existing.slug },
    req,
  });

  sendSuccess(res, { deleted: true });
}
