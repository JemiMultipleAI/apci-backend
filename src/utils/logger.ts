/**
 * Enhanced logger with environment-based and configurable log levels
 * Supports filtering by LOG_LEVEL environment variable for production
 * 
 * Usage:
 * - Development: LOG_LEVEL defaults to 'debug' (shows all logs)
 * - Production: LOG_LEVEL defaults to 'info' (shows info, warn, error)
 * - Override: Set LOG_LEVEL=debug|info|warn|error to control verbosity
 * 
 * Guidelines:
 * - ERROR: All errors, exceptions, failures (always logged)
 * - WARN: Configuration issues, deprecated features, fallbacks
 * - INFO: Important business events (campaign started, call connected, message sent)
 * - DEBUG: Detailed debugging (chunk sizes, state transitions, processing steps)
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

class Logger {
  private logLevel: LogLevel;
  private isDevelopment = process.env.NODE_ENV === 'development';

  constructor() {
    // Allow LOG_LEVEL override (e.g., LOG_LEVEL=info for production)
    const envLogLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel);
    const validLevels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    
    if (envLogLevel && validLevels.includes(envLogLevel)) {
      this.logLevel = envLogLevel;
    } else if (this.isDevelopment) {
      this.logLevel = 'debug'; // Show all logs in development
    } else {
      this.logLevel = 'info'; // Default production: info, warn, error
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }

  // Backward compatible: supports both old style (...args) and new style (message, meta)
  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log('[DEBUG]', ...args);
    }
  }

  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log('[INFO]', ...args);
    }
  }

  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn('[WARN]', ...args);
    }
  }

  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error('[ERROR]', ...args);
    }
  }
}

export const logger = new Logger();

