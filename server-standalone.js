#!/usr/bin/env node

/**
 * Standalone Order Execution Backend Server
 * HTTP + WebSocket support without npm dependencies
 * Processes market orders with DEX routing
 */

const http = require('http');
const url = require('url');
const crypto = require('crypto');

// ============ UTILITIES ============

/**
 * Pause execution for the specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} Resolves after the delay
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a unique identifier combining timestamp and random bytes
 * Format: {timestamp}-{randomHex}
 * @returns {string} Unique ID
 */
function uuidv4() {
  return `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

// ============ MOCK DEX ROUTER ============

/**
 * MockDexRouter simulates two DEX protocols (Raydium and Meteora)
 * Provides price quotes and simulates swap execution with realistic latency
 * 
 * Price Model:
 * - Raydium: 98-102% of base price with 0.3% fee
 * - Meteora: 97-102% of base price with 0.2% fee (slightly better price but less consistent)
 */
class MockDexRouter {
  constructor() {
    this.basePrice = 100; // Base price used for all simulated quotes
  }

  /**
   * Get a price quote from Raydium DEX
   * Simulates network latency (200-400ms) and realistic price variance
   * @param {string} tokenIn - Input token symbol
   * @param {string} tokenOut - Output token symbol
   * @param {number} amount - Amount to swap
   * @returns {Promise<{price, fee, dex}>} Quote with price, fee, and DEX name
   */
  async getRaydiumQuote(tokenIn, tokenOut, amount) {
    // Simulate network latency for fetching quote
    await sleep(200 + Math.random() * 200);
    // Generate price with 2% variance (98-102% of base price)
    const price = this.basePrice * (0.98 + Math.random() * 0.04);
    return { price, fee: 0.003, dex: 'raydium' };
  }

  /**
   * Get a price quote from Meteora DEX
   * Similar latency but slightly different price range (97-102%)
   * @param {string} tokenIn - Input token symbol
   * @param {string} tokenOut - Output token symbol
   * @param {number} amount - Amount to swap
   * @returns {Promise<{price, fee, dex}>} Quote with price, fee, and DEX name
   */
  async getMeteoraQuote(tokenIn, tokenOut, amount) {
    // Simulate network latency
    await sleep(200 + Math.random() * 200);
    // Generate price with 5% variance (97-102% of base price) - wider range
    const price = this.basePrice * (0.97 + Math.random() * 0.05);
    return { price, fee: 0.002, dex: 'meteora' };
  }

  /**
   * Execute a swap on the selected DEX
   * Simulates transaction confirmation time (2-3 seconds)
   * @param {string} dex - DEX name ('raydium' or 'meteora')
   * @param {object} order - Order object containing swap details
   * @returns {Promise<{txHash, executedPrice}>} Transaction hash and final execution price
   */
  async executeSwap(dex, order) {
    // Simulate blockchain transaction confirmation time
    await sleep(2000 + Math.random() * 1000);
    // Generate a unique transaction hash
    const txHash = uuidv4();
    // Calculate executed price with slight slippage (±0.5%)
    const executedPrice = this.basePrice * (dex === 'raydium' ? 1.0 : 0.995) * (1 + (Math.random() - 0.5) * 0.01);
    return { txHash, executedPrice };
  }
}

// ============ ORDER PROCESSOR ============

/**
 * Map of active WebSocket connections
 * Key: orderId, Value: send function to emit status updates
 * Used to maintain bidirectional communication with connected clients
 */
const wsClients = new Map();

/**
 * Process an order through the complete execution pipeline
 * 
 * Pipeline stages:
 * 1. pending - Order received, waiting for routing
 * 2. routing - Fetching quotes from both DEXs in parallel
 * 3. building - Selecting best DEX and preparing transaction
 * 4. submitted - Transaction submitted to blockchain
 * 5. confirmed - Transaction confirmed and order complete
 * 
 * Each stage emits a status update via WebSocket
 * 
 * @param {object} data - Order data {type, tokenIn, tokenOut, amountIn}
 * @param {string} orderId - Unique order identifier for tracking
 * @returns {Promise<{txHash}>} Transaction hash on success
 * @throws {Error} If any stage fails, emits 'failed' status and rethrows
 */
async function processOrder(data, orderId) {
  // Initialize DEX router for this order
  const dex = new MockDexRouter();
  const shortId = orderId.substring(0, 12);
  
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📋 ORDER QUEUED [${shortId}]`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  💱 Swap: ${data.amountIn} ${data.tokenIn} → ${data.tokenOut}`);
  console.log(`  🔀 Type: Market Order (immediate execution)`);
  console.log(`${'─'.repeat(80)}`);

  /**
   * Helper function to emit status updates to the client via WebSocket
   * @param {object} payload - Status update object with status and optional details
   */
  function emit(payload) {
    const sender = wsClients.get(orderId);
    if (sender) {
      try {
        sender(JSON.stringify(payload));
      } catch (e) {
        // Silently ignore send failures (client may have disconnected)
      }
    }
  }

  try {
    // Stage 1: Order received
    console.log(`\n⏳ [${shortId}] STAGE 1/5: PENDING`);
    console.log(`  └─ Order received in queue, awaiting processing...`);
    emit({ status: 'pending' });

    // Stage 2: Routing - fetch quotes from both DEXs in parallel
    console.log(`\n🔀 [${shortId}] STAGE 2/5: ROUTING (Fetching DEX quotes in parallel...)`);
    const startRoute = Date.now();
    const [r, m] = await Promise.all([
      (async () => {
        console.log(`  └─ Querying Raydium...`);
        const quote = await dex.getRaydiumQuote(data.tokenIn, data.tokenOut, data.amountIn);
        console.log(`     ✓ Raydium Quote: $${quote.price.toFixed(2)} (fee: ${(quote.fee * 100).toFixed(2)}%)`);
        return quote;
      })(),
      (async () => {
        console.log(`  └─ Querying Meteora...`);
        const quote = await dex.getMeteoraQuote(data.tokenIn, data.tokenOut, data.amountIn);
        console.log(`     ✓ Meteora Quote: $${quote.price.toFixed(2)} (fee: ${(quote.fee * 100).toFixed(2)}%)`);
        return quote;
      })()
    ]);
    const routeTime = Date.now() - startRoute;

    // Choose DEX with better price (lower price = better rate for swap)
    const chosen = r.price <= m.price ? r : m;
    const other = r.price <= m.price ? m : r;
    console.log(`\n📊 [${shortId}] ROUTING DECISION:`);
    console.log(`  ✅ SELECTED: ${chosen.dex.toUpperCase()} @ $${chosen.price.toFixed(2)}`);
    console.log(`     vs.    ${other.dex.toUpperCase()} @ $${other.price.toFixed(2)} (difference: ${Math.abs(other.price - chosen.price).toFixed(2)})`);
    console.log(`  ⏱️  Route time: ${routeTime}ms`);
    emit({ status: 'routing', chosen: chosen.dex, price: chosen.price.toFixed(2) });

    // Stage 3: Building - prepare transaction
    console.log(`\n🔨 [${shortId}] STAGE 3/5: BUILDING (Preparing transaction...)`);
    const startBuild = Date.now();
    await sleep(200); // Simulate transaction preparation
    const buildTime = Date.now() - startBuild;
    console.log(`  └─ ✓ Transaction prepared (${buildTime}ms)`);
    emit({ status: 'building' });

    // Stage 4: Submitted - execute the swap on blockchain
    console.log(`\n🚀 [${shortId}] STAGE 4/5: SUBMITTED (Broadcasting to ${chosen.dex}...)`);
    const startExec = Date.now();
    const exec = await dex.executeSwap(chosen.dex, data);
    const execTime = Date.now() - startExec;
    console.log(`  └─ ✓ Transaction confirmed in ${execTime}ms`);
    console.log(`     TX: ${exec.txHash.substring(0, 24)}...`);
    emit({ status: 'submitted' });

    // Stage 5: Confirmed - order complete
    console.log(`\n✅ [${shortId}] STAGE 5/5: CONFIRMED (Order complete!)`);
    console.log(`  └─ Executed Price: $${exec.executedPrice.toFixed(2)}`);
    console.log(`  └─ Slippage: ${Math.abs((exec.executedPrice - chosen.price) / chosen.price * 100).toFixed(2)}%`);
    console.log(`\n${'═'.repeat(80)}`);
    emit({ status: 'confirmed', txHash: exec.txHash.slice(0, 16) + '...', executedPrice: exec.executedPrice.toFixed(2) });
    return { txHash: exec.txHash };
  } catch (err) {
    // On error, emit failed status and rethrow for logging
    const reason = err?.message || String(err);
    console.log(`\n❌ [${shortId}] STAGE FAILED: ${reason}`);
    console.log(`${'═'.repeat(80)}`);
    emit({ status: 'failed', error: reason });
    throw err;
  }
}

// ============ HTTP SERVER ============

/**
 * Server port configuration
 * Uses PORT environment variable or defaults to 3000
 */
const PORT = parseInt(process.env.PORT || '3000', 10);

/**
 * HTTP Server that handles order submission
 * 
 * Endpoints:
 * - POST /api/orders/execute - Submit a new market order
 * 
 * CORS is enabled for all origins to allow frontend communication
 */
const server = http.createServer((req, res) => {
  // Enable CORS for cross-origin requests from frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Parse URL and extract path and query parameters
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // ===== Serve static files from public folder =====
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, 'public', filePath);
    
    // Security: prevent directory traversal
    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      
      const contentType = filePath.endsWith('.html') ? 'text/html' : 
                         filePath.endsWith('.js') ? 'text/javascript' :
                         filePath.endsWith('.css') ? 'text/css' : 'text/plain';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
    return;
  }

  // ===== POST /api/orders/execute - Submit Order =====
  if (pathname === '/api/orders/execute' && req.method === 'POST') {
    let body = '';
    
    // Collect incoming data chunks
    req.on('data', (chunk) => {
      body += chunk.toString('utf8');
      // Protect against excessively large payloads (>1MB)
      if (body.length > 1e6) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      }
    });

    // Process complete request body
    req.on('end', () => {
      try {
        // Parse JSON body
        const data = JSON.parse(body);

        // Validate required fields
        if (!data || data.type !== 'market' || !data.tokenIn || !data.tokenOut || !data.amountIn) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid order. required: type=market, tokenIn, tokenOut, amountIn' }));
          return;
        }

        // Generate unique order ID and WebSocket URL for client
        const orderId = uuidv4();
        // Determine host and protocol, preferring forwarded headers (used by proxies)
        const forwardedHost = req.headers['x-forwarded-host'];
        const forwardedProto = req.headers['x-forwarded-proto'];
        const host = forwardedHost || req.headers.host || 'localhost:' + PORT;
        // Prefer wss when the original request was https or proxy indicates https
        const isSecure = (forwardedProto && forwardedProto.includes('https')) || (host && host.includes('railway.app')) || (req.connection && req.connection.encrypted);
        const protocol = isSecure ? 'wss' : 'ws';
        // Strip any port from host when appropriate (keep host as provided otherwise)
        const cleanHost = host.split(',')[0].trim();
        const wsUrl = `${protocol}://${cleanHost}/api/orders/execute?orderId=${orderId}`;
        const shortId = orderId.substring(0, 12);
        // Log the WebSocket URL sent to the client for debugging
        console.log(`   └─ WS URL: ${wsUrl}`);

        // Log order submission
        console.log(`\n📥 NEW ORDER RECEIVED [${shortId}]`);
        console.log(`   POST /api/orders/execute`);
        console.log(`   Amount: ${data.amountIn} ${data.tokenIn} → ${data.tokenOut}`);

        // Start processing order asynchronously (don't block HTTP response)
        processOrder(data, orderId).catch((e) => {
          console.error(`[${shortId}] Fatal Error:`, e.message);
        });

        // Log queue entry
        console.log(`   ✓ Enqueued to processing queue`);

        // Respond with order ID and WebSocket URL
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ orderId, wsUrl }));
      } catch (err) {
        // Handle JSON parsing errors
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Fallback: Return 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// ============ WEBSOCKET HANDLER ============

/**
 * WebSocket upgrade handler for bidirectional communication
 * 
 * Handles HTTP upgrade requests and converts them to WebSocket connections
 * Following RFC 6455 protocol standard
 * 
 * Connection flow:
 * 1. Client sends HTTP Upgrade request with valid WebSocket headers
 * 2. Server validates orderId query parameter
 * 3. Server sends 101 Switching Protocols response
 * 4. Connection is registered in wsClients Map
 * 5. Status updates are sent via WebSocket frames
 */
server.on('upgrade', (req, socket, head) => {
  // Parse URL to extract pathname and query parameters
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  if (pathname === '/api/orders/execute') {
    // Extract order ID from query parameter
    const orderId = query.orderId;
    if (!orderId) {
      // Reject connection if orderId is missing
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    // ===== Upgrade to WebSocket Protocol (RFC 6455) =====
    
    // Extract the WebSocket key from request headers
    const key = req.headers['sec-websocket-key'];
    
    // Compute the acceptance hash using the protocol-defined GUID
    // This proves the server understands the WebSocket protocol
    const hash = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    // Send upgrade response to complete the handshake
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${hash}\r\n` +
      '\r\n'
    );

    /**
     * Send function: wraps messages in WebSocket frames
     * @param {string} msg - Message to send (JSON string)
     */
    const send = (msg) => {
      try {
        const buf = Buffer.from(msg);
        const frame = createWebSocketFrame(buf);
        socket.write(frame);
      } catch (e) {
        // Silently ignore send errors
      }
    };

    // Register this connection for receiving order status updates
    const shortId = orderId.substring(0, 12);
    console.log(`\n🔌 WEBSOCKET CONNECTED [${shortId}]`);
    console.log(`   └─ Listening for status updates...`);
    wsClients.set(orderId, send);

    // Handle client disconnection - cleanup
    socket.on('close', () => {
      console.log(`🔌 WEBSOCKET DISCONNECTED [${shortId}]`);
      wsClients.delete(orderId);
    });

    // Handle socket errors - cleanup
    socket.on('error', () => {
      wsClients.delete(orderId);
    });
  } else {
    // Reject upgrade for unknown paths
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }
});

/**
 * Create a WebSocket frame following RFC 6455 specification
 * 
 * Frame structure:
 * [0x81] [payload length] [payload]
 * 
 * The first byte (0x81) indicates:
 * - FIN bit (0x80): Message is final fragment
 * - opcode (0x01): Text frame
 * 
 * Payload length encoding depends on actual length:
 * - < 126 bytes: 1 byte length field
 * - 126-65535 bytes: 2 byte length field with 126 marker
 * - >= 65536 bytes: 8 byte length field with 127 marker
 * 
 * @param {Buffer} payload - Message content to send
 * @returns {Buffer} Complete WebSocket frame ready to transmit
 */
function createWebSocketFrame(payload) {
  const len = payload.length;
  let frame;

  if (len < 126) {
    // Short payload: 2 bytes header + payload
    frame = Buffer.alloc(len + 2);
    frame[0] = 0x81; // FIN bit (1) + text opcode (1)
    frame[1] = len;  // Payload length
    payload.copy(frame, 2);
  } else if (len < 65536) {
    // Medium payload: 4 bytes header + payload
    frame = Buffer.alloc(len + 4);
    frame[0] = 0x81;
    frame[1] = 126;  // Extended length marker
    frame.writeUInt16BE(len, 2); // 2-byte length
    payload.copy(frame, 4);
  } else {
    // Large payload: 10 bytes header + payload
    frame = Buffer.alloc(len + 10);
    frame[0] = 0x81;
    frame[1] = 127;  // Extended length marker for 8-byte length
    frame.writeBigUInt64BE(BigInt(len), 2); // 8-byte length
    payload.copy(frame, 10);
  }

  return frame;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║      🚀 Order Execution Engine - Backend Server 🚀            ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  console.log('📊 System Configuration:');
  console.log(`   ✓ HTTP Server: http://localhost:${PORT}`);
  console.log(`   ✓ WebSocket: ws://localhost:${PORT}`);
  console.log(`   ✓ Order API: POST /api/orders/execute`);
  console.log(`   ✓ DEX Routing: Raydium ↔ Meteora`);
  console.log(`   ✓ Processing: Concurrent (queue-based)\n`);
  console.log('📋 Order Lifecycle:');
  console.log('   1. PENDING → 2. ROUTING → 3. BUILDING → 4. SUBMITTED → 5. CONFIRMED\n');
  console.log('🔄 Console Output Enabled:');
  console.log('   • Order submission logs');
  console.log('   • DEX quote fetching & comparison');
  console.log('   • Routing decisions');
  console.log('   • WebSocket connections');
  console.log('   • Status updates (pending → confirmed)\n');
  console.log('🎯 Ready to process orders!\n');
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
