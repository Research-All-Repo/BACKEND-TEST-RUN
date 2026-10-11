'use strict';
const express = require('express');

/**
 * Mock edge controls (ADMIN, only mounted when MOCK_EDGE_ENABLED=true).
 * In serverless (on-request) mode the offline switch is stored in dashboard_audit_log.
 * Lets you demonstrate the error states: take the simulated Pi "offline",
 * bring it back, or force a cycle now.
 */
module.exports = function devRoutes(mockEdge) {
  const router = express.Router();
  router.get('/', async (_req, res, next) => {
    try { res.json({ data: await mockEdge.status() }); } catch (err) { next(err); }
  });
  router.post('/', async (req, res, next) => {
    try {
      if (typeof req.body?.offline === 'boolean') await mockEdge.setOffline(req.body.offline, req.auth.user.id);
      if (req.body?.tick) await mockEdge.tick();
      res.json({ data: await mockEdge.status() });
    } catch (err) {
      next(err);
    }
  });
  return router;
};
