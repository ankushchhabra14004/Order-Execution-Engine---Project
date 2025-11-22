#!/usr/bin/env node

/**
 * Simple static file server for the order execution frontend
 * Serves public/index.html on port 3001 (or PORT env var)
 * No external dependencies
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Server port configuration
 * Uses FRONTEND_PORT environment variable or defaults to 3001
 */
const PORT = parseInt(process.env.FRONTEND_PORT || '3001', 10);

/**
 * Directory path for static files
 * All requests are resolved relative to the 'public' folder
 */
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * HTTP Server for serving static frontend files
 * Provides the HTML UI and handles basic file serving
 * 
 * Features:
 * - CORS enabled for cross-origin requests
 * - Directory traversal protection for security
 * - Automatic root path routing to index.html
 */
const server = http.createServer((req, res) => {
  // Enable CORS headers for cross-origin requests from any domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route root path '/' to index.html
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Resolve relative path to absolute path within PUBLIC_DIR
  filePath = path.join(PUBLIC_DIR, filePath);

  // Security check: Prevent directory traversal attacks
  // Ensure resolved path is still within PUBLIC_DIR
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // Check if file exists and is a regular file (not directory)
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Determine content type based on file extension
    const contentType = filePath.endsWith('.html') ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'Content-Type': contentType });
    // Stream file directly to response
    fs.createReadStream(filePath).pipe(res);
  });
});

// Start listening on configured port
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Frontend server listening on http://localhost:${PORT}\n`);
  console.log(`📂 Serving files from: ${PUBLIC_DIR}\n`);
  console.log('🔗 Open http://localhost:3001 in your browser\n');
});

// Handle server errors
server.on('error', (err) => {
  console.error('❌ Server error:', err);
  process.exit(1);
});
