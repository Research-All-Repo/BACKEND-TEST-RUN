'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const S = require('../services/dashboard');
const { unwrap, E } = require('../lib/errors');
const { assertUuid, UUID_RE, sanitizeText } = require('../lib/helpers');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/aerator
 * Requested mode vs controller-acknowledged mode, controller-reported output,
 * pending command, recent commands. The dashboard never writes aerator state
 * directly; see POST /commands.
 */
router.get('/', async (req, res, next) => {
  try {
    res.json({ data: await S.getAeratorSummary(req.auth.db) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/aerator/commands  { requested_state: "ON" | "OFF" }
 * Creates a PENDING MANUAL_DASHBOARD request through the request_aerator_command
 * RPC. The Raspberry Pi later validates (mode, expiry, idempotency) and applies
 * it, then reports APPLIED / REJECTED / FAILED / EXPIRED. Send an
 * Idempotency-Key header (UUID) so a network retry cannot create a second command.
 * Response 202: accepted for delivery, NOT "aerator is running".
 */
router.post('/commands', async (req, res, next) => {
  try {
    const { db } = req.auth;
    const state = String(req.body?.requested_state || '').toUpperCase();
    if (!['ON', 'OFF'].includes(state)) throw E.validation('requested_state must be ON or OFF.');
    const key = req.get('Idempotency-Key');
    const commandId = key && UUID_RE.test(key) ? key.toLowerCase() : crypto.randomUUID();
    const row = unwrap(await db.rpc('request_aerator_command', {
      p_command_id: commandId, p_requested_state: state, p_expires_in_seconds: config.aeratorCommandTtlSeconds,
    }));
    res.status(202).json({
      data: S.decorateCommand(row),
      meta: { message: `Aerator ${state} request sent. Waiting for the controller to acknowledge it.`,
        poll: `/api/aerator/commands/${row.command_id}` },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/aerator/commands/:commandId - poll one command's lifecycle. */
router.get('/commands/:commandId', async (req, res, next) => {
  try {
    const id = assertUuid(req.params.commandId, 'commandId');
    const row = unwrap(await req.auth.db.from('aerator_commands').select('*').eq('command_id', id).maybeSingle());
    if (!row) throw E.notFound('Command not found.');
    res.json({ data: S.decorateCommand(row) });
  } catch (err) {
    next(err);
  }
});

/** GET /api/aerator/commands?limit=50 - command history. */
router.get('/commands', async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = unwrap(await req.auth.db.from('aerator_commands').select('*').order('requested_at_utc', { ascending: false }).limit(limit));
    res.json({ data: rows.map((r) => S.decorateCommand(r)) });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/aerator/mode  (ADMIN)  { mode: "MANUAL" | "AUTOMATIC", automatic_rule_version? }
 * Bumps settings_revision; the controller acknowledges by setting applied_mode/applied_revision.
 */
router.post('/mode', requireRole('ADMIN'), async (req, res, next) => {
  try {
    const mode = String(req.body?.mode || '').toUpperCase();
    if (!['MANUAL', 'AUTOMATIC'].includes(mode)) throw E.validation('mode must be MANUAL or AUTOMATIC.');
    const rule = sanitizeText(req.body?.automatic_rule_version, 60) || (mode === 'AUTOMATIC' ? 'AUTO-RULE-1.0' : null);
    const row = unwrap(await req.auth.db.rpc('request_aerator_mode', { p_mode: mode, p_automatic_rule_version: rule }));
    res.status(202).json({ data: row, meta: { message: `Mode ${mode} requested (revision ${row.settings_revision}). Waiting for controller acknowledgement.` } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
