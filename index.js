import 'dotenv/config';
import mongoose from 'mongoose';
import { Telegraf } from 'telegraf';
import { connectDB, seedSuperAdmin } from './models/db.js';
import { setupBot } from './bot/handlers.js';
import { createServer, startServer } from './api/server.js';
import { log, formatError } from './helpers/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log.boot('Starting Credentials Bot…');
log.boot(`Node ${process.version}`);

// ---- Fail fast when required configuration is missing ----
const REQUIRED_ENV = ['BOT_TOKEN', 'MONGODB_URI', 'HASH_PEPPER'];
const missingEnv = REQUIRED_ENV.filter((key) => !String(process.env[key] || '').trim());
if (missingEnv.length) {
  log.error(`Missing required environment variables: ${missingEnv.join(', ')}.`);
  log.error('Fill them in bot/.env and start again.');
  process.exit(1);
}

// ---- Central error handling (never crash the process on a stray error) ----
process.on('uncaughtException', (err) => log.error(`Uncaught exception: ${formatError(err)}`));
process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${formatError(reason)}`));

// ---- Database with reconnect on failure ----
async function connectWithRetry() {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await connectDB();
      return true;
    } catch (err) {
      log.error(`DB connection failed (attempt ${attempt}/${maxAttempts}): ${formatError(err)}`);
      if (attempt === maxAttempts) return false;
      await sleep(Math.min(30_000, 3_000 * attempt));
    }
  }
  return false;
}

if (!(await connectWithRetry())) {
  log.error('Could not reach the database. Exiting.');
  process.exit(1);
}

try {
  await seedSuperAdmin();
} catch (err) {
  log.error(`Super admin seeding failed: ${formatError(err)}`);
}

// Watchdog: reconnect the DB if the connection drops for good.
setInterval(() => {
  if (mongoose.connection.readyState === 0) {
    log.warn('DB connection is down, reconnecting…');
    connectWithRetry().catch((err) => log.error(`DB reconnect failed: ${formatError(err)}`));
  }
}, 30_000);

// ---- Bot ----
const bot = new Telegraf(process.env.BOT_TOKEN);
setupBot(bot);

async function launchWithRetry() {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const me = await bot.telegram.getMe();
      log.bot(`Authorized as @${me.username || 'n/a'} (${me.id})`);
      await bot.telegram.setMyCommands([
        { command: 'start', description: 'Start the bot' },
        { command: 'cancel', description: 'Cancel the current step' },
      ]);
      await bot.launch();
      log.bot('Launched and polling.');
      return;
    } catch (err) {
      log.error(`Bot launch failed (attempt ${attempt}): ${formatError(err)}`);
      await sleep(Math.min(30_000, 3_000 * attempt));
    }
  }
}

// ---- Admin API + web panel backend ----
const app = createServer({ bot });
const server = startServer(app);

await launchWithRetry();

// ---- Graceful shutdown ----
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.boot(`Received ${signal}, shutting down…`);
  try {
    bot.stop(signal);
  } catch (err) {
    log.warn(`Bot stop failed: ${err.message}`);
  }
  server.close(() => log.api('Server closed.'));
  await mongoose.connection.close().catch(() => {});
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
