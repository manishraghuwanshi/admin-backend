import type { RequestHandler } from "express";

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Route not found: ${req.method} ${req.path}`,
    },
    requestId: req.requestId,
  });
};
