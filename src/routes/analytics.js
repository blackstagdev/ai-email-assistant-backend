const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { AnalyticsService } = require('../services/AnalyticsService');

const router = Router();
router.use(authMiddleware);

// GET /api/analytics/dashboard - Get all dashboard metrics
router.get('/dashboard', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { timeRange = 'month' } = req.query;

    const metrics = await AnalyticsService.getDashboardMetrics(
      userId,
      timeRange as 'day' | 'week' | 'month' | 'year'
    );

    res.json(metrics);
  } catch (error) {
    console.error('Error fetching dashboard metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/revenue - Get revenue analytics
router.get('/revenue', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { timeRange = 'month' } = req.query;

    const analytics = await AnalyticsService.getRevenueAnalytics(
      userId,
      timeRange as 'day' | 'week' | 'month' | 'year'
    );

    res.json(analytics);
  } catch (error) {
    console.error('Error fetching revenue analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/interactions - Get interaction metrics
router.get('/interactions', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { timeRange = 'month' } = req.query;

    const analytics = await AnalyticsService.getInteractionAnalytics(
      userId,
      timeRange as 'day' | 'week' | 'month' | 'year'
    );

    res.json(analytics);
  } catch (error) {
    console.error('Error fetching interaction analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/contacts/growth - Get contact growth metrics
router.get('/contacts/growth', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { timeRange = 'month' } = req.query;

    const analytics = await AnalyticsService.getContactGrowth(
      userId,
      timeRange as 'day' | 'week' | 'month' | 'year'
    );

    res.json(analytics);
  } catch (error) {
    console.error('Error fetching contact growth:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/analytics/marketing - Get marketing attribution
router.get('/marketing', async (req, res) => {
  try {
    const userId = req.user!.userId;

    const analytics = await AnalyticsService.getMarketingAttribution(userId);

    res.json(analytics);
  } catch (error) {
    console.error('Error fetching marketing analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
