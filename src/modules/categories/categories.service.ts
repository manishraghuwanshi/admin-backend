import { and, asc, count, desc, eq, ilike, isNull, type SQL } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";

import { db } from "../../db/index.js";
import { categories, productCategories } from "../../db/schema.js";
import { recordAudit } from "../../lib/audit.js";
import { badRequest, notFound, unprocessable } from "../../utils/errors.js";
import { sendPaginated, sendSuccess } from "../../utils/http.js";
import { paginationMeta, paginationOffset, paginationQuerySchema } from "../../utils/pagination.js";
import { optionalBooleanQuery, slugSchema, uuidParamSchema } from "../../utils/schemas.js";

/**
 * Categories are always paginated, like every other list in the API.
 *
 * This route used to return a bare array whenever neither `page` nor `limit` was
 * supplied, which forced the frontend to branch on the shape of the response. The
 * shared `paginationQuerySchema` supplies the defaults instead, so the envelope is
 * the same whether or not the caller asks for a page.
 */
export const categoryListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(100).optional(),
  isActive: optionalBooleanQuery,
  parentId: z.union([z.literal("null"), z.uuid()]).optional(),
  sort: z.enum(["sortOrder", "name", "createdAt", "updatedAt"]).default("sortOrder"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

export const categoryBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: slugSchema.max(120),
  description: z.string().trim().max(5000).nullable().optional(),
  parentId: z.uuid().nullable().optional(),
  imageStorageKey: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

export const categoryUpdateSchema = categoryBodySchema.partial();

async function assertValidParent(categoryId: string | undefined, parentId: string | null): Promise<void> {
  if (!parentId) {
    return;
  }

  if (categoryId && parentId === categoryId) {
    throw badRequest("A category cannot be its own parent");
  }

  const [parent] = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories).where(eq(categories.id, parentId)).limit(1);

  if (!parent) {
    throw unprocessable("Parent category does not exist");
  }

  if (!categoryId) {
    return;
  }

  let currentParentId: string | null = parent.parentId;
  let depth = 0;

  while (currentParentId && depth < 20) {
    if (currentParentId === categoryId) {
      throw badRequest("This parent would create a circular category relationship");
    }

    const [next]: Array<{ parentId: string | null } | undefined> = await db
      .select({ parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.id, currentParentId))
      .limit(1);

    currentParentId = next?.parentId ?? null;
    depth += 1;
  }
}

export async function listCategories(req: Request, res: Response): Promise<void> {
  const query = req.validatedQuery as z.infer<typeof categoryListQuerySchema>;
  const filters: SQL[] = [];

  if (query.search) {
    filters.push(ilike(categories.name, `%${query.search}%`));
  }

  if (query.isActive !== undefined) {
    filters.push(eq(categories.isActive, query.isActive));
  }

  if (query.parentId === "null") {
    filters.push(isNull(categories.parentId));
  } else if (query.parentId) {
    filters.push(eq(categories.parentId, query.parentId));
  }

  const where = filters.length ? and(...filters) : undefined;
  const sortColumn = {
    sortOrder: categories.sortOrder,
    name: categories.name,
    createdAt: categories.createdAt,
    updatedAt: categories.updatedAt,
  }[query.sort];

  const direction = query.order === "asc" ? asc : desc;

  // `name` and `id` break ties. Without them two rows sharing a `sortOrder` (the
  // default is 0 for every new category) sort arbitrarily, so page 2 can repeat or
  // skip a row that page 1 already showed.
  const orderBy = [direction(sortColumn), asc(categories.name), asc(categories.id)];

  const [{ total }] = await db.select({ total: count() }).from(categories).where(where);
  const rows = await db
    .select()
    .from(categories)
    .where(where)
    .orderBy(...orderBy)
    .limit(query.limit)
    .offset(paginationOffset(query.page, query.limit));

  sendPaginated(res, rows, paginationMeta(query.page, query.limit, Number(total)));
}

export async function getCategory(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const [row] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);

  if (!row) {
    throw notFound("Category not found");
  }

  sendSuccess(res, row);
}

export async function createCategory(req: Request, res: Response): Promise<void> {
  const body = req.validatedBody as z.infer<typeof categoryBodySchema>;
  await assertValidParent(undefined, body.parentId ?? null);

  const [created] = await db
    .insert(categories)
    .values({
      name: body.name,
      slug: body.slug,
      description: body.description ?? null,
      parentId: body.parentId ?? null,
      imageStorageKey: body.imageStorageKey ?? null,
      isActive: body.isActive ?? true,
      sortOrder: body.sortOrder ?? 0,
    })
    .returning();

  await recordAudit({
    actorId: req.authUser?.id,
    action: "category.create",
    entityType: "category",
    entityId: created.id,
    metadata: { slug: created.slug },
    req,
  });

  sendSuccess(res, created, 201);
}

export async function updateCategory(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const body = req.validatedBody as z.infer<typeof categoryUpdateSchema>;
  const [existing] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);

  if (!existing) {
    throw notFound("Category not found");
  }

  const nextParent = body.parentId === undefined ? existing.parentId : body.parentId;
  await assertValidParent(id, nextParent);

  const [updated] = await db
    .update(categories)
    .set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
      ...(body.imageStorageKey !== undefined ? { imageStorageKey: body.imageStorageKey } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      updatedAt: new Date(),
    })
    .where(eq(categories.id, id))
    .returning();

  await recordAudit({
    actorId: req.authUser?.id,
    action: "category.update",
    entityType: "category",
    entityId: id,
    req,
  });

  sendSuccess(res, updated);
}

export async function deleteCategory(req: Request, res: Response): Promise<void> {
  const { id } = req.validatedParams as z.infer<typeof uuidParamSchema>;
  const [existing] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);

  if (!existing) {
    throw notFound("Category not found");
  }

  const [{ childCount }] = await db
    .select({ childCount: count() })
    .from(categories)
    .where(eq(categories.parentId, id));

  if (Number(childCount) > 0) {
    throw unprocessable("Cannot delete a category that still has child categories");
  }

  const [{ productCount }] = await db
    .select({ productCount: count() })
    .from(productCategories)
    .where(eq(productCategories.categoryId, id));

  if (Number(productCount) > 0) {
    throw unprocessable("Cannot delete a category that is still assigned to products");
  }

  await db.delete(categories).where(eq(categories.id, id));

  await recordAudit({
    actorId: req.authUser?.id,
    action: "category.delete",
    entityType: "category",
    entityId: id,
    metadata: { slug: existing.slug },
    req,
  });

  sendSuccess(res, { deleted: true });
}
