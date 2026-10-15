/*
 * Scheduled Driver Unassign - error model
 * AdvantageOne
 *
 * Every failure the service can produce has a stable code, because the add-in
 * maps codes to user-facing text (see src/addin/api-client.js). Never invent a
 * code at a call site; add it here and to the client's ERROR_TEXT map.
 */
"use strict";

const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  SESSION_INVALID: 401,
  DATABASE_NOT_ONBOARDED: 403,
  ADDIN_ACCESS_DENIED: 403,
  CLEARANCE_REQUIRED: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  GEOTAB_ERROR: 500,
  INTERNAL: 500
};

class AppError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AppError";
    this.code = STATUS_BY_CODE[code] ? code : "INTERNAL";
    this.status = STATUS_BY_CODE[this.code];
    if (details && Object.keys(details).length) this.details = details;
  }
}

function appError(code, message, details) {
  return new AppError(code, message, details);
}

/** Anything thrown that is not an AppError becomes a generic internal error. */
function asAppError(error) {
  if (error instanceof AppError) return error;
  const message = error && error.message ? error.message : String(error);
  return new AppError("INTERNAL", message);
}

function errorBody(error) {
  const app = asAppError(error);
  const body = { code: app.code, message: app.message };
  if (app.details) body.details = app.details;
  return body;
}

module.exports = { AppError, appError, asAppError, errorBody, STATUS_BY_CODE };
