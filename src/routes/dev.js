'use strict';
const express = require('express');

/**
 * Mock edge controls (ADMIN, only mounted when MOCK_EDGE_ENABLED=true).
 * Lets you demonstrate the error states: take the simulated Pi "offline",
 * bring it back, or force a cycle now.
 */
module.exports = function devRoutes(mockEdge) {
  const router = express.Router();
  router.get('/', (_req, res) => res.json({ data: mockEdge.status() }));
  router.post('/', async (req, res, next) => {
    try {
      if (typeof req.body?.offline === 'boolean') mockEdge.setOffline(req.body.offline);
      if (req.body?.tick) await mockEdge.tick();
      res.json({ data: mockEdge.status() });
    } catch (err) {
      next(err);
    }
  });
  return router;
};
