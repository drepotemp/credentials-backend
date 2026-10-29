import mongoose from 'mongoose';
import { log, formatError } from '../helpers/logger.js';

const userSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    codeHash: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
  },
  { timestamps: true }
);
export const User = mongoose.model('User', userSchema);

const adminSchema = new mongoose.Schema(
  {
    userId: { type: String, default: null, unique: true, sparse: true },
    username: { type: String, default: null, unique: true, sparse: true },
    isSuper: { type: Boolean, default: false },
  },
  { timestamps: true }
);
export const Admin = mongoose.model('Admin', adminSchema);

export function statusLabel(status) {
  if (status === 'approved') return 'Approved✅';
  if (status === 'rejected') return 'Rejected❌';
  return 'Pending🟡';
}

/** Checks whether a Telegram user id or username belongs to an admin. */
export async function isAdmin({ userId, username } = {}) {
  const or = [];
  if (userId) or.push({ userId: String(userId) });
  if (username) or.push({ username: String(username).replace(/^@/, '').toLowerCase() });
  if (!or.length) return false;
  const found = await Admin.findOne({ $or: or }).lean();
  return Boolean(found);
}

export async function connectDB() {
  mongoose.set('runValidators', true);
  const dbName = process.env.DB_NAME || 'Credentials_bot';
  log.db(`Connecting to "${dbName}" …`);
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName,
    serverSelectionTimeoutMS: 30_000,
    connectTimeoutMS: 30_000,
    socketTimeoutMS: 120_000,
    heartbeatFrequencyMS: 10_000,
  });
  log.db('Connected.');

  mongoose.connection.on('disconnected', () => log.warn('[DB] Disconnected. Driver will retry automatically.'));
  mongoose.connection.on('reconnected', () => log.db('Reconnected.'));
  mongoose.connection.on('error', (err) => log.error(`[DB] ${formatError(err)}`));
}

/** Seeds the super admin from env if it does not exist yet. */
export async function seedSuperAdmin() {
  const id = process.env.SUPERADMIN_ID ? String(process.env.SUPERADMIN_ID).trim() : '';
  if (!id) {
    log.warn('SUPERADMIN_ID is not set, skipping super admin seeding.');
    return;
  }
  const existing = await Admin.findOne({ userId: id });
  if (existing) {
    if (!existing.isSuper) {
      existing.isSuper = true;
      await existing.save();
    }
    log.db(`Super admin already present (${id}).`);
    return;
  }
  await Admin.create({ userId: id, username: null, isSuper: true });
  log.db(`Super admin seeded (${id}).`);
}
