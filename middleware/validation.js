// middleware/validation.js - Input validation middleware
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Validate room ID format
 */
function validateRoomId(req, res, next) {
  const { roomId } = req.params;

  if (!roomId) {
    logger.warn('Missing room ID in request', { url: req.url });
    return res.status(400).json({
      error: 'Room ID is required'
    });
  }

  if (!config.validation.isValidRoomId(roomId)) {
    logger.warn('Invalid room ID format', { roomId, url: req.url });
    return res.status(400).json({
      error: 'Invalid room ID format. Room ID must be a 32-character hexadecimal string.'
    });
  }

  next();
}

/**
 * Validate role parameter
 */
function validateRole(req, res, next) {
  const { role } = req.query;

  if (role && !config.validation.isValidRole(role)) {
    logger.warn('Invalid role parameter', { role, url: req.url });
    return res.status(400).json({
      error: 'Invalid role. Must be either "baby" or "parent".'
    });
  }

  next();
}

/**
 * Sanitize user input to prevent XSS
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return input;

  return input
    .replace(/[<>]/g, '') // Remove angle brackets
    .trim()
    .substring(0, 100); // Limit length
}

/**
 * Validate Socket.IO join event data
 */
function validateSocketJoinData(data) {
  const errors = [];

  if (!data.roomId || !config.validation.isValidRoomId(data.roomId)) {
    errors.push('Invalid or missing room ID');
  }

  if (!data.role || !config.validation.isValidRole(data.role)) {
    errors.push('Invalid or missing role');
  }

  if (data.userName && !config.validation.isValidUserName(data.userName)) {
    errors.push('Invalid user name (must be 1-50 characters)');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

module.exports = {
  validateRoomId,
  validateRole,
  sanitizeInput,
  validateSocketJoinData
};
