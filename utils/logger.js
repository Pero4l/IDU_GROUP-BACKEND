const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logLevels = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG',
};

// Formats a log entry as a timestamped string.
function formatEntry(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ` | ${JSON.stringify(meta)}` : '';
  return `[${timestamp}] [${level}] ${message}${metaStr}`;
}

// Writes a log entry to the appropriate file and to stdout/stderr.
function log(level, message, meta = {}) {
  const entry = formatEntry(level, message, meta);
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const file = path.join(logsDir, `${today}-${level.toLowerCase()}.log`);

  // Write to file (non-blocking, best effort)
  fs.appendFile(file, entry + '\n', (err) => {
    if (err) console.error('Logger: failed to write to log file', err);
  });

  // Also write to also console
  if (level === logLevels.ERROR) {
    console.error(entry);
  } else {
    console.log(entry);
  }
}

const logger = {
  info:  (message, meta) => log(logLevels.INFO,  message, meta),
  warn:  (message, meta) => log(logLevels.WARN,  message, meta),
  error: (message, meta) => log(logLevels.ERROR, message, meta),
  debug: (message, meta) => log(logLevels.DEBUG, message, meta),
};

module.exports = logger;
