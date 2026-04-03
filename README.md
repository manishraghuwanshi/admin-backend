# Admin Backend

Backend API for the administrative dashboard of the watch e-commerce project.

This application is the administrative API only. It owns administrator
authentication, authorization, the product catalog, inventory, and audit
events. Customer-facing commerce (storefront, cart, orders, checkout) is a
separate future application and is deliberately out of scope here.

## Technology Stack

- Node.js
- pnpm
- TypeScript
- Express 5
- PostgreSQL (Neon Serverless Postgres)
- Drizzle ORM + Drizzle Kit
- postgres.js
- Zod
- `jose`
- Argon2
- Neon Object Storage (product images)

The project is ECMAScript modules (`"type": "module"`), and source files use
NodeNext resolution, so relative imports carry a `.js` extension.

## Requirements

- Node.js 20 or newer
- pnpm

## Installation

```bash
pnpm install
```

## Environment Variables

Copy the template and fill in real values:

```bash
cp .env.example .env
```

`DATABASE_URL` is required in every environment. Never commit `.env` — it is
git-ignored.

## Development

```bash
pnpm dev
```

The server listens on `PORT` (default `5000`).

```bash
curl http://localhost:5000/health
```

## Type Checking

```bash
pnpm type-check
```

## Production Build

```bash
pnpm build
pnpm start
```

## Project Status

Early scaffolding. The application skeleton, environment validation, database
connection, and schema are being built up first; administrative endpoints and
their authorization rules follow.