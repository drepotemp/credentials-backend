import express from 'express';
import cors from 'cors';
import { Admin, User, statusLabel } from '../models/db.js';
import { log, formatError } from '../helpers/logger.js';

const STATUSES = ['pending', 'approved', 'rejected'];

function publicUser(u) {
  return {
    id: u._id,
    telegramId: u.telegramId,
    username: u.username,
    firstName: u.firstName,
    email: u.email,
    status: u.status,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function createServer({ bot } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  /** Auth middleware: accepts an admin username or Telegram id. */
  async function adminAuth(req, res, next) {
    const raw = req.get('x-admin-key') || req.query.key;
    const identifier = String(raw || '').trim().replace(/^@/, '').toLowerCase();
    if (!identifier) return res.status(401).json({ error: 'Missing admin credentials.' });

    try {
      const admin = await Admin.findOne({
        $or: [{ userId: String(raw).trim() }, { username: identifier }],
      }).lean();
      if (!admin) return res.status(403).json({ error: 'Not an admin.' });
      req.admin = admin;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  app.get('/ping', (_req, res) => res.send('hello world'));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.post('/api/auth/verify', adminAuth, (req, res) => {
    res.json({ admin: { userId: req.admin.userId, username: req.admin.username, isSuper: req.admin.isSuper } });
  });

  app.get('/api/stats', adminAuth, async (_req, res, next) => {
    try {
      const [total, pending, approved, rejected, admins] = await Promise.all([
        User.countDocuments({}),
        User.countDocuments({ status: 'pending' }),
        User.countDocuments({ status: 'approved' }),
        User.countDocuments({ status: 'rejected' }),
        Admin.countDocuments({}),
      ]);
      res.json({ total, pending, approved, rejected, admins });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/users', adminAuth, async (req, res, next) => {
    try {
      const { status, q } = req.query;
      const filter = {};
      if (status && STATUSES.includes(status)) filter.status = status;
      if (q) {
        const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        filter.$or = [{ email: rx }, { username: rx }, { telegramId: rx }, { firstName: rx }];
      }
      const users = await User.find(filter).sort({ createdAt: -1 }).limit(500).lean();
      res.json({ users: users.map(publicUser) });
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/users/:id', adminAuth, async (req, res, next) => {
    try {
      const { status } = req.body || {};
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
      const user = await User.findByIdAndUpdate(req.params.id, { status }, { new: true }).lean();
      if (!user) return res.status(404).json({ error: 'User not found.' });
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/users/:id', adminAuth, async (req, res, next) => {
    try {
      const user = await User.findByIdAndDelete(req.params.id).lean();
      if (!user) return res.status(404).json({ error: 'User not found.' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admins', adminAuth, async (_req, res, next) => {
    try {
      const admins = await Admin.find({}).sort({ createdAt: 1 }).lean();
      res.json({ admins });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admins', adminAuth, async (req, res, next) => {
    try {
      const raw = String(req.body?.identifier || '').trim().replace(/^@/, '');
      if (!raw) return res.status(400).json({ error: 'Provide an admin username or Telegram id.' });
      const isId = /^\d+$/.test(raw);

      const existing = await Admin.findOne(isId ? { userId: raw } : { username: raw.toLowerCase() }).lean();
      if (existing) return res.status(409).json({ error: 'That admin already exists.' });

      const admin = await Admin.create(
        isId ? { userId: raw } : { username: raw.toLowerCase() }
      );
      res.status(201).json({ admin });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/admins/:id', adminAuth, async (req, res, next) => {
    try {
      const admin = await Admin.findById(req.params.id).lean();
      if (!admin) return res.status(404).json({ error: 'Admin not found.' });
      if (admin.isSuper) return res.status(400).json({ error: 'The super admin cannot be removed.' });
      await Admin.findByIdAndDelete(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Central error handler.
  app.use((err, _req, res, _next) => {
    log.error(`[API] ${formatError(err)}`);
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}

export function startServer(app) {
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, () => log.api(`Listening on http://localhost:${port}`));
  server.on('error', (err) => log.error(`[API] Server error: ${formatError(err)}`));
  return server;
}
