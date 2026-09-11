import 'dotenv/config';
import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '8787', 10);
const host = process.env.HOST ?? '127.0.0.1';
const app = createApp();
const server = app.listen(port, host, () => {
  console.log(`Amazon AI Opportunity Intelligence API: http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    const database = app.locals.database as { close?: () => void };
    database.close?.();
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
