'use strict';

/**
 * Every API error is returned as:
 *   { "error": { "code": "SESSION_EXPIRED", "message": "...", "details": {...} } }
 * The frontend switches on `code`, never on the message text.
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const E = {
  validation: (message, details) => new ApiError(400, 'VALIDATION_ERROR', message, details),
  sessionMissing: () => new ApiError(401, 'SESSION_MISSING', 'You are not signed in.'),
  sessionExpired: () => new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired or is no longer valid. Please sign in again.'),
  invalidCredentials: () => new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.'),
  emailNotVerified: () => new ApiError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address using the link sent to your inbox before signing in.'),
  accountStatus: (status) => {
    const map = {
      PENDING: ['ACCOUNT_PENDING', 'This AquaCast account is still pending Administrator approval.'],
      SUSPENDED: ['ACCOUNT_SUSPENDED', 'This AquaCast account is currently suspended. Contact an Administrator for access.'],
      REVOKED: ['ACCOUNT_REVOKED', 'Access for this AquaCast account has been revoked.'],
      NO_PROFILE: ['ACCOUNT_NOT_AUTHORIZED', 'This account is not registered for AquaCast access.'],
    };
    const [code, message] = map[status] || map.NO_PROFILE;
    return new ApiError(403, code, message);
  },
  forbidden: (message = 'Your role is not authorized for this action.') => new ApiError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found.') => new ApiError(404, 'NOT_FOUND', message),
  conflict: (code, message, details) => new ApiError(409, code, message, details),
  rateLimited: (retryAfterSeconds) => new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', { retry_after_seconds: retryAfterSeconds }),
  supabaseUnavailable: () => new ApiError(503, 'SUPABASE_UNAVAILABLE', 'The AquaCast database could not be reached. Please try again shortly.'),
  supabaseFailed: (details) => new ApiError(502, 'SUPABASE_REQUEST_FAILED', 'The database request failed.', details),
};

// RPC exception names (raised in 002_dashboard_access.sql) -> HTTP responses
const RPC_ERRORS = {
  AUTH_REQUIRED: [401, 'SESSION_EXPIRED', 'Your session is no longer valid. Please sign in again.'],
  ACCOUNT_NOT_ACTIVE: [403, 'ACCOUNT_NOT_ACTIVE', 'Your account is not active.'],
  ADMIN_REQUIRED: [403, 'FORBIDDEN', 'Administrator role required.'],
  INVALID_STATE: [400, 'VALIDATION_ERROR', 'Requested state must be ON or OFF.'],
  INVALID_EXPIRY: [400, 'VALIDATION_ERROR', 'Command expiry must be between 30 and 600 seconds.'],
  COMMAND_ID_CONFLICT: [409, 'COMMAND_ID_CONFLICT', 'That command ID is already used by a different command.'],
  AERATOR_NOT_INITIALIZED: [409, 'AERATOR_NOT_INITIALIZED', 'Aerator settings have not been initialized by the edge device yet.'],
  AERATOR_NOT_IN_MANUAL_MODE: [409, 'AERATOR_NOT_IN_MANUAL_MODE', 'Manual ON/OFF requests are only accepted while the controller has acknowledged MANUAL mode.'],
  AERATOR_COMMAND_ALREADY_PENDING: [409, 'AERATOR_COMMAND_ALREADY_PENDING', 'Another aerator command is still waiting for the controller. Wait for it to be applied or expire.'],
  INVALID_MODE: [400, 'VALIDATION_ERROR', 'Mode must be MANUAL or AUTOMATIC.'],
  AUTOMATIC_RULE_VERSION_REQUIRED: [400, 'VALIDATION_ERROR', 'An automatic rule version is required for AUTOMATIC mode.'],
  INVALID_EVENT_TYPE: [400, 'VALIDATION_ERROR', 'Unknown activity type.'],
  INVALID_EVENT_TIME: [400, 'VALIDATION_ERROR', 'Invalid activity time (start is required, end must follow start, neither may be in the future).'],
  MANUAL_AERATION_NEEDS_END_TIME: [400, 'VALIDATION_ERROR', 'A manually recorded aeration activity needs an end time. Open aeration sessions are created by the controller.'],
  NOTES_REQUIRED_FOR_OTHER: [400, 'VALIDATION_ERROR', 'Notes are required when the activity type is OTHER.'],
  EVENT_NOT_FOUND: [404, 'NOT_FOUND', 'Activity record not found.'],
  CONTROLLER_EVENT_READ_ONLY: [403, 'FORBIDDEN', 'Controller-recorded aeration sessions cannot be edited from the dashboard.'],
  EVENT_ALREADY_CLOSED: [409, 'EVENT_ALREADY_CLOSED', 'This activity already has an end time.'],
  NOT_EVENT_AUTHOR: [403, 'FORBIDDEN', 'Only the person who recorded this activity (or an Administrator) can close it.'],
  ALERT_NOT_FOUND: [404, 'NOT_FOUND', 'Alert not found.'],
  ALERT_ALREADY_ACKNOWLEDGED: [409, 'ALERT_ALREADY_ACKNOWLEDGED', 'This alert was already acknowledged.'],
  CANNOT_MODIFY_SELF: [403, 'CANNOT_MODIFY_SELF', 'You cannot change your own access status or role.'],
  USER_NOT_FOUND: [404, 'NOT_FOUND', 'User not found.'],
  INVALID_ROLE: [400, 'VALIDATION_ERROR', 'Role must be ADMIN or BFAR_STAFF.'],
  INVALID_TRANSITION: [409, 'INVALID_TRANSITION', 'That action is not allowed for the user\'s current status.'],
  INVALID_ACTION: [400, 'VALIDATION_ERROR', 'Unknown user action.'],
  LAST_ACTIVE_ADMIN: [409, 'LAST_ACTIVE_ADMIN', 'At least one active Administrator must remain.'],
  REASON_REQUIRED: [400, 'VALIDATION_ERROR', 'A reason is required for this action.'],
  FIELD_NOT_EDITABLE: [400, 'VALIDATION_ERROR', 'That study field is not editable from the dashboard.'],
  INVALID_TIMEZONE: [400, 'VALIDATION_ERROR', 'Timezone must be a valid IANA identifier, e.g. Asia/Manila.'],
  STUDY_NOT_FOUND: [404, 'NOT_FOUND', 'Study metadata record not found.'],
};

function isNetworkError(err) {
  const text = `${err?.message || ''} ${err?.details || ''} ${err?.cause?.code || ''}`;
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|socket hang up|UND_ERR/i.test(text);
}

/** Convert a supabase-js / PostgREST error into an ApiError. */
function fromSupabase(err) {
  if (!err) return null;
  if (err instanceof ApiError) return err;
  if (isNetworkError(err)) return E.supabaseUnavailable();
  const name = String(err.message || '').trim();
  if (RPC_ERRORS[name]) {
    const [status, code, message] = RPC_ERRORS[name];
    return new ApiError(status, code, message, err.hint ? { hint: err.hint } : undefined);
  }
  if (err.code === 'PGRST301' || err.code === 'PGRST302' || /JWT expired|invalid JWT/i.test(name)) return E.sessionExpired();
  if (err.code === '42501') return E.forbidden('The database refused this request for your account.');
  if (err.code === '23505') return E.conflict('DUPLICATE', 'A record with the same key already exists.');
  if (err.code === '23514' || err.code === '23503' || err.code === '22023' || err.code === '22P02') {
    return E.validation('The database rejected this record.', { db_message: name });
  }
  if (err.code === 'PGRST116') return E.notFound();
  return E.supabaseFailed({ db_code: err.code || null });
}

/** Throw if a supabase-js response carries an error; return data otherwise. */
function unwrap({ data, error }) {
  if (error) throw fromSupabase(error);
  return data;
}

module.exports = { ApiError, E, fromSupabase, unwrap, isNetworkError };
