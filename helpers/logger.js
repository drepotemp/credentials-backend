function ts() {
  return new Date().toISOString();
}

function write(tag, message) {
  console.log(`${tag} [${ts()}] ${message}`);
}

function writeErr(tag, message) {
  console.error(`${tag} [${ts()}] ${message}`);
}

export function formatError(err) {
  if (!err) return 'Unknown error';
  return err.stack || err.message || String(err);
}

export const log = {
  boot: (m) => write('🚀', `[Boot] ${m}`),
  info: (m) => write('ℹ️ ', `[Info] ${m}`),
  db: (m) => write('🗄️ ', `[DB] ${m}`),
  bot: (m) => write('🤖', `[Bot] ${m}`),
  api: (m) => write('🌐', `[API] ${m}`),
  ok: (m) => write('✅', `${m}`),
  warn: (m) => write('⚠️ ', `[Warn] ${m}`),
  error: (m) => writeErr('💥', `[Error] ${m}`),
};
