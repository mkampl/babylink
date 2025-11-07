// utils/logger.js - Centralized logging with Winston
const winston = require('winston');
const path = require('path');
const config = require('../config');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format (colorized for development)
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
      msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
  })
);

// Create transports
const transports = [
  new winston.transports.Console({
    format: consoleFormat,
    level: config.logging.level,
  })
];

// Add file transport if enabled
if (config.logging.toFile) {
  const logDir = path.dirname(config.logging.filePath);

  transports.push(
    new winston.transports.File({
      filename: config.logging.filePath,
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );

  // Separate error log file
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      format: logFormat,
      maxsize: 10485760, // 10MB
      maxFiles: 5,
      tailable: true
    })
  );
}

// Create logger instance
const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports,
  exitOnError: false,
});

// Add helper methods for structured logging
logger.logRequest = (req, message) => {
  logger.info(message, {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
};

logger.logSocketEvent = (eventName, socketId, data) => {
  logger.debug(`Socket event: ${eventName}`, {
    socketId,
    data
  });
};

logger.logRoomEvent = (roomId, eventName, data) => {
  logger.info(`Room event: ${eventName}`, {
    roomId,
    ...data
  });
};

// Graceful error handling
logger.on('error', (error) => {
  console.error('Logger error:', error);
});

module.exports = logger;
