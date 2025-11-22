**Order Execution Engine (Mock, Market Orders)**

Overview:
- This project implements a mock Order Execution Engine supporting Market orders with DEX routing between Raydium and Meteora (simulated).
- It focuses on architecture: routing, queue processing, WebSocket status streaming, retries and persistence hooks.

Why Market Order:
- I implemented Market orders because they exercise immediate routing and execution logic (price comparison + slippage handling) and demonstrate the full lifecycle quickly. The same engine can be extended to Limit or Sniper by adding an order scheduler that watches prices or on-chain events and enqueues orders when criteria match.

Order Submission
- User submits an order via POST `/api/orders/execute`.
- The API validates the order payload and returns an `orderId` and a websocket URL (`wsUrl`).
- The same HTTP endpoint supports an upgrade to WebSocket for live updates; the client opens a WebSocket (or upgrades the same connection) to receive real-time status events for the returned `orderId`.

Why this order type
- Market orders were chosen because they exercise the full routing and execution flow immediately (quote collection, comparison, build, submit, confirm), which makes it easier to demonstrate and test end-to-end behavior.

Extending to Limit / Sniper (1-2 lines)
- The engine can support Limit orders by adding a scheduler that watches prices and enqueues a market execution when the target price is reached. Sniper orders can be implemented by subscribing to on-chain or mempool events and enqueueing aggressive market executions when a launch condition is detected.

Quick Start (local, dev):
1. Copy `.env.example` to `.env` and adjust `REDIS_URL` and `PG_CONN`.
2. Install dependencies:
```bash
npm install
```
3. Start Redis and Postgres locally (or point `.env` to services).
4. Start server:
```bash
npm run start
```

API:
- POST `/api/orders/execute` - submit a market order
  - body: `{ "type":"market", "tokenIn":"A", "tokenOut":"B", "amountIn":100, "slippage":0.01 }`
  - returns: `{ orderId, wsUrl }` — open the `wsUrl` (same path) to receive live status updates.

WebSocket:
- Connect to the `wsUrl` returned from POST (e.g., `ws://localhost:3000/api/orders/execute?orderId=<id>`).
- Sequence of statuses emitted: `pending` → `routing` → `building` → `submitted` → `confirmed` (or `failed`).

Notes on Single-endpoint Handling:
- The server supports both HTTP POST and a WebSocket connection on `/api/orders/execute`. The POST returns an `orderId` and `wsUrl`. The client should open a WebSocket to the same path with `?orderId=...` to receive updates. In production you can accept an upgrade on the same connection (101 Switching Protocols), but for simplicity this mock returns a URL to connect.

Files of Interest:
- `src/dex/mockDexRouter.ts` – simulated Raydium/Meteora quotes and swap exec
- `src/queue/orderQueue.ts` – BullMQ queue wrapper (retries/backoff configured)
- `src/workers/orderWorker.ts` – worker and exported `processOrder` function
- `src/index.ts` – Fastify server + WS endpoint

