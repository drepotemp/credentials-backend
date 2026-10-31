import { Markup } from 'telegraf';
import { Admin, User, isAdmin, statusLabel } from '../models/db.js';
import { hashSecret } from '../helpers/hash.js';
import { log, formatError } from '../helpers/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_DIR = path.join(__dirname, '..', 'assets');

const sessions = new Map();

const getSession = (id) => sessions.get(String(id));
const setSession = (id, data) => sessions.set(String(id), data);
const clearSession = (id) => sessions.delete(String(id));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STRATEGY_BUTTONS = ['ICT', 'SMC', 'Price Action'];
const MENU_BUTTONS = [...STRATEGY_BUTTONS, 'My Account', 'Help'];

/** The menu buttons are always visible as keyboard buttons. */
function mainMenu() {
  return Markup.keyboard([
    ['ICT', 'SMC', 'Price Action'],
    ['My Account', 'Help']
  ]).resize();
}

function adminPanelMenu() {
  const url = process.env.ADMIN_PANEL_URL;
  if (!url) return Markup.inlineKeyboard([[Markup.button.callback('Open admin panel', 'admin_panel_unset')]]);
  return Markup.inlineKeyboard([[Markup.button.webApp('Launch', url)]]);
}

function beginRegistration(ctx) {
  setSession(ctx.from.id, { step: 'awaiting_email', data: {} });
  return ctx.reply('Welcome! To get started, please send me your email address.', mainMenu());
}

export async function handleText(ctx) {
  const text = (ctx.message.text || '').trim();

  // Help button (inactive)
  if (text === 'Help') {
    return ctx.reply('Help & Support is currently unavailable. Please check back later.', mainMenu());
  }

  // My Account logic
  if (text === 'My Account') {
    const user = await User.findOne({ telegramId: String(ctx.from.id) });
    if (!user) {
      return ctx.reply('You are not registered yet. Please use /start to begin.', mainMenu());
    }
    
    let statusMsg = `👤 *My Account*\n\n`;
    statusMsg += `*Email:* ${user.email}\n`;
    statusMsg += `*Status:* ${statusLabel(user.status)}\n\n`;

    if (user.status === 'pending') {
      statusMsg += `Your registration is being reviewed. Please wait up to 24 hours.`;
    } else if (user.status === 'rejected') {
      statusMsg += `Your registration was rejected. You can use /start to submit your details again.`;
    } else if (user.status === 'approved') {
      statusMsg += `Your account is active! You can now access all features.`;
    }

    return ctx.replyWithMarkdown(statusMsg, mainMenu());
  }

  // Strategy buttons logic
  if (STRATEGY_BUTTONS.includes(text)) {
    const user = await User.findOne({ telegramId: String(ctx.from.id) });
    if (!user || user.status !== 'approved') {
      await ctx.reply(
        'Please register first. After completing registration, click this button again to access the feature.',
        mainMenu()
      );

      const session = getSession(ctx.from.id);
      if (session) {
        if (session.step === 'awaiting_email') {
          return ctx.reply('Send me your email address', mainMenu());
        }
        if (session.step === 'awaiting_password') {
          return ctx.reply('Send me your account password', mainMenu());
        }
        if (session.step === 'awaiting_code') {
          return ctx.reply('Send me the verification code', mainMenu());
        }
      }
      return;
    }
    // Features for approved users could go here
    return ctx.reply(`Accessing ${text} strategy...`, mainMenu());
  }

  const session = getSession(ctx.from.id);
  if (!session) return;

  if (session.step === 'awaiting_email') {
    if (!EMAIL_RE.test(text))
      return ctx.reply('That does not look like a valid email. Send me your email address', mainMenu());
    session.data.email = text.toLowerCase();
    session.step = 'awaiting_password';
    setSession(ctx.from.id, session);
    await ctx.reply('Send me your account password', mainMenu()).catch(() => {});
    return;
  }

  if (session.step === 'awaiting_password') {
    if (!text) return ctx.reply('Send me your account password', mainMenu());
    session.data.password = text;
    session.step = 'awaiting_code';
    setSession(ctx.from.id, session);
    await ctx.deleteMessage().catch(() => {});
    return ctx.reply('Send me the verification code', mainMenu());
  }

  if (session.step === 'awaiting_code') {
    if (!text) return ctx.reply('Send me the verification code', mainMenu());
    const { email, password } = session.data;
    await ctx.deleteMessage().catch(() => {});
    clearSession(ctx.from.id);

    const existing = await User.findOne({ telegramId: String(ctx.from.id) });
    if (existing) {
      if (existing.status === 'rejected') {
        // Allow re-registration if rejected
        await User.deleteOne({ telegramId: String(ctx.from.id) });
      } else {
        return ctx.reply(`Already registered.\nAccount Status: ${statusLabel(existing.status)}`, mainMenu());
      }
    }

    const [passwordHash, codeHash] = await Promise.all([hashSecret(password), hashSecret(text)]);
    const user = await User.create({
      telegramId: String(ctx.from.id),
      username: ctx.from.username || null,
      firstName: ctx.from.first_name || null,
      email,
      passwordHash,
      codeHash,
      status: 'pending',
    });

    await ctx.reply(
      'Your registration has been submitted successfully. Please wait up to 24 hours for your account to be activated.',
      mainMenu()
    );
    return;
  }
}

export function setupBot(bot) {
  bot.start(async (ctx) => {
    const admin = await isAdmin({ userId: ctx.from.id, username: ctx.from.username });
    if (admin) {
      return ctx.reply('Welcome to the admin panel', adminPanelMenu());
    }

    const user = await User.findOne({ telegramId: String(ctx.from.id) });
    if (user) {
      if (user.status === 'rejected') {
        // Clear status and restart if rejected
        await User.deleteOne({ telegramId: String(ctx.from.id) });
      } else {
        return ctx.reply(`Welcome back!\n\nAccount Status: ${statusLabel(user.status)}`, mainMenu());
      }
    }

    const welcomeImg = path.join(ASSETS_DIR, 'images', 'welcome.jpg');
    
    await ctx.replyWithPhoto({ source: welcomeImg }, {
      caption: `Welcome to the Premium Credentials Bot. 🚀\n\nExperience professional-grade trading strategies and insights. To access Price Action, SMC, and ICT tools, please complete your registration below.`,
      ...mainMenu()
    });

    return beginRegistration(ctx);
  });

  bot.command('cancel', async (ctx) => {
    clearSession(ctx.from.id);
    await ctx.reply('Canceled.');
  });

  bot.action('admin_panel_unset', (ctx) =>
    ctx.answerCbQuery('Admin panel URL is not configured.', { show_alert: true }).catch(() => {})
  );

  bot.action(/^decision:(approved|rejected):(.+)$/, async (ctx) => {
    if (!(await isAdmin({ userId: ctx.from.id, username: ctx.from.username }))) {
      return ctx.answerCbQuery('Admins only.', { show_alert: true }).catch(() => {});
    }
    await ctx.answerCbQuery().catch(() => {});

    const [, status, telegramId] = ctx.match;
    const user = await User.findOneAndUpdate({ telegramId }, { status }, { new: true });
    if (!user) return ctx.editMessageText('User no longer exists.').catch(() => {});

    await ctx
      .editMessageText(`${ctx.callbackQuery.message.text}\n\nStatus: ${statusLabel(status)}`)
      .catch(() => {});
  });

  bot.on('text', (ctx) => handleText(ctx));

  bot.catch((err, ctx) => {
    log.error(`Unhandled bot error (update ${ctx?.update?.update_id}): ${formatError(err)}`);
  });
}
