import type { Response } from "express";

import type { PaginationMeta } from "./pagination.js";

export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({
    success: true,
    data,
  });
}

export function sendPaginated<T>(res: Response, data: T[], pagination: PaginationMeta): void {
  res.status(200).json({
    success: true,
    data,
    pagination,
  });
}
