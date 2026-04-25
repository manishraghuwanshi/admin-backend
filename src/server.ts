import { createApp } from "./app.js";
import { closeDatabase } from "./db/index.js";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";

/** Owns process startup, listening, and graceful shutdown only. */

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info("Admin backend started", {
    port: env.PORT,
    environment: env.NODE_ENV,
    pid: process.pid,
  });
});

server.on("error", (error) => {
  logger.error("HTTP server error", { error });
  process.exitCode = 1;
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    logger.warn("Shutdown already in progress", { signal });

    return;
  }

  shuttingDown = true;

  logger.info("Shutdown signal received", { signal, timeoutMs: env.SHUTDOWN_TIMEOUT_MS });

  // Force-exit if connections refuse to drain within the grace period.
  const forceExit = setTimeout(() => {
    logger.error("Forced shutdown: connections did not close in time", {
      timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    });

    server.closeAllConnections();
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);

  forceExit.unref();

  server.close(async (error) => {
    if (error) {
      logger.error("Failed to close HTTP server", { error });
      process.exitCode = 1;
    }

    try {
      await closeDatabase();
    } catch (dbError) {
      logger.error("Failed to close database connection", { error: dbError });
      process.exitCode = 1;
    }

    clearTimeout(forceExit);

    logger.info("Shutdown complete", { signal });

    process.exit(process.exitCode ?? 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(signal));
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason });
  process.exitCode = 1;
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception, shutting down", { error });

  shutdown("SIGTERM");
});