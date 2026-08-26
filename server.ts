import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import path from 'path';
import 'dotenv/config';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = 3000;

// Setup Finnhub WebSocket
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_KEY) {
  console.error('FINNHUB_API_KEY environment variable is required');
}

const socket = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

// Throttle configuration
const lastSent = new Map<string, number>();
const THROTTLE_MS = 500; // 2 updates per second max

socket.on('open', () => {
  console.log('Connected to Finnhub');
  // Subscribe to symbols
  socket.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:EUR_USD' }));
  socket.send(JSON.stringify({ type: 'subscribe', symbol: 'OANDA:GBP_USD' }));
});

socket.on('message', (data: WebSocket.RawData) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'trade') {
    message.data.forEach((trade: any) => {
      const { s: symbol, p: price, t: timestamp } = trade;
      
      // Throttle updates
      if (Date.now() - (lastSent.get(symbol) || 0) > THROTTLE_MS) {
        io.emit('priceUpdate', { symbol, price, timestamp });
        lastSent.set(symbol, Date.now());
      }
    });
  }
});

socket.on('close', () => {
  console.log('Finnhub connection closed. Implement reconnection logic here.');
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
  });
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
