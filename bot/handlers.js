import { Markup } from 'telegraf';
import { Admin, User, isAdmin, statusLabel } from '../models/db.js';
import { hashSecret } from '../helpers/hash.js';
import { log, formatError } from '../helpers/logger.js';

const sessions = new Map();

const getSession = (id) => sessions.get(String(id));
const setSession = (id, data) => sessions.set(String(id), data);
const clearSession = (id) => sessions.delete(String(id));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STRATEGY_BUTTONS = ['ICT', 'SMC', 'Price Action'];

/** The three strategy buttons are always visible as keyboard buttons. */
function mainMenu() {
  return Markup.keyboard([STRATEGY_BUTTONS]).resize();
}

function adminPanelMenu() {
  const url = process.env.ADMIN_PANEL_URL;
  if (!url) return Markup.inlineKeyboard([[Markup.button.callback('Open admin panel', 'admin_panel_unset')]]);
  return Markup.inlineKeyboard([[Markup.button.webApp('Launch', url)]]);
}

function beginRegistration(ctx) {
  setSession(ctx.from.id, { step: 'awaiting_email', data: {} });
  return ctx.reply('Send me your email address', mainMenu());
}

export async function handleText(ctx) {
  const text = (ctx.message.text || '').trim();

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
    return;
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
      return ctx.reply(`Already registered.\nAccount Status: ${statusLabel(existing.status)}`, mainMenu());
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
      return ctx.reply(`Already registered.\nAccount Status: ${statusLabel(user.status)}`, mainMenu());
    }
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
