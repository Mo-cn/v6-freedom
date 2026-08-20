/**
 * ⚠️ DISCLAIMER: This tool is for educational purposes only.
 * Using it to bypass service restrictions may violate ToS.
 * Use at your own risk. The author assumes no liability.
 */
'use strict';

// 轻量日志器：分级 + 时间戳，避免第三方依赖。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor(level = 'info') {
    this.level = LEVELS[level] || LEVELS.info;
    this.prefix = '[socks5]';
  }

  _write(levelName, levelValue, args) {
    if (levelValue < this.level) return;
    const time = new Date().toISOString();
    const line = `${time} ${this.prefix} ${levelName.padEnd(5)} ${args.join(' ')}`;
    if (levelValue >= LEVELS.error) console.error(line);
    else console.log(line);
  }

  debug(...args) { this._write('debug', LEVELS.debug, args); }
  info(...args) { this._write('info', LEVELS.info, args); }
  warn(...args) { this._write('warn', LEVELS.warn, args); }
  error(...args) { this._write('error', LEVELS.error, args); }
}

module.exports = { Logger, LEVELS };
