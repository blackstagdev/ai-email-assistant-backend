const { query } = require('../db');

;
  interactions: {
    emails: number;
    messages: number;
    calls: number;
    meetings: number;
  };
  revenue: {
    total: number;
    thisMonth: number;
    thisWeek: number;
    today: number;
  };
  support: {
    openTickets: number;
    resolvedTickets: number;
    avgResolutionTime: number;
    satisfactionScore: number;
  };
  trends: {
    interactionsByDay: Array<{ date: string; count: number }>;
    revenueByDay: Array<{ date: string; amount: number }>;
    topContacts: Array<{
      id: string;
      name: string;
      email: string;
      revenue: number;
      interactions: number;
    }>;
  };
}

class AnalyticsService {
  // Get comprehensive dashboard metrics
  static async getDashboardMetrics(
    userId,
    timeRange: 'day' | 'week' | 'month' | 'year' = 'month'
  ) {
    const dateFilter = this.getDateFilter(timeRange);

    // Overview metrics
    const overviewResult = await query(
      `SELECT 
        COUNT(DISTINCT c.id)_contacts,
        COUNT(DISTINCT i.id)_interactions,
        COALESCE(SUM(c.total_revenue), 0)_revenue,
        COUNT(DISTINCT CASE WHEN c.last_contact_date >= NOW() - INTERVAL '30 days' THEN c.id END)_contacts
       FROM contacts c
       LEFT JOIN interactions i ON c.id = i.contact_id
       WHERE c.user_id = $1`,
      [userId]
    );

    // Interaction breakdown
    const interactionsResult = await query(
      `SELECT 
        interaction_type,
        COUNT(*)_id = $1 AND occurred_at >= $2
       GROUP BY interaction_type`,
      [userId, dateFilter]
    );

    const interactionCounts = interactionsResult.rows.reduce((acc, row) => {
      acc[row.interaction_type] = parseInt(row.count);
      return acc;
    }, {});

    // Revenue metrics
    const revenueResult = await query(
      `SELECT 
        COALESCE(SUM(CASE WHEN order_date >= NOW() - INTERVAL '1 day' THEN order_total END), 0),
        COALESCE(SUM(CASE WHEN order_date >= NOW() - INTERVAL '7 days' THEN order_total END), 0)_week,
        COALESCE(SUM(CASE WHEN order_date >= NOW() - INTERVAL '30 days' THEN order_total END), 0)_month,
        COALESCE(SUM(order_total), 0)_data
       WHERE user_id = $1`,
      [userId]
    );

    // Support metrics
    const supportResult = await query(
      `SELECT 
        COUNT(CASE WHEN status IN ('open', 'pending') THEN 1 END)_tickets,
        COUNT(CASE WHEN status IN ('resolved', 'closed') THEN 1 END)_tickets,
        AVG(resolution_time_hours)_resolution_time,
        AVG(satisfaction_score)_satisfaction
       FROM support_tickets
       WHERE user_id = $1 AND created_at >= $2`,
      [userId, dateFilter]
    );

    // Interactions by day
    const interactionTrendsResult = await query(
      `SELECT 
        DATE(occurred_at),
        COUNT(*)_id = $1 AND occurred_at >= $2
       GROUP BY DATE(occurred_at)
       ORDER BY date DESC`,
      [userId, dateFilter]
    );

    // Revenue by day
    const revenueTrendsResult = await query(
      `SELECT 
        DATE(order_date),
        SUM(order_total)_data
       WHERE user_id = $1 AND order_date >= $2
       GROUP BY DATE(order_date)
       ORDER BY date DESC`,
      [userId, dateFilter]
    );

    // Top contacts by engagement
    const topContactsResult = await query(
      `SELECT 
        c.id,
        c.first_name || ' ' || c.last_name,
        c.email,
        c.total_revenue,
        COUNT(i.id).id = i.contact_id AND i.occurred_at >= $2
       WHERE c.user_id = $1
       GROUP BY c.id, c.first_name, c.last_name, c.email, c.total_revenue
       ORDER BY c.total_revenue DESC, interactions DESC
       LIMIT 10`,
      [userId, dateFilter]
    );

    const overview = overviewResult.rows[0];
    const revenue = revenueResult.rows[0];
    const support = supportResult.rows[0];

    return {
      overview: {
        totalContacts: parseInt(overview.total_contacts),
        totalInteractions: parseInt(overview.total_interactions),
        totalRevenue: parseFloat(overview.total_revenue),
        activeContacts: parseInt(overview.active_contacts),
      },
      interactions: {
        emails: interactionCounts.email || 0,
        messages: interactionCounts.message || 0,
        calls: interactionCounts.call || 0,
        meetings: interactionCounts.meeting || 0,
      },
      revenue: {
        total: parseFloat(revenue.total),
        thisMonth: parseFloat(revenue.this_month),
        thisWeek: parseFloat(revenue.this_week),
        today: parseFloat(revenue.today),
      },
      support: {
        openTickets: parseInt(support.open_tickets) || 0,
        resolvedTickets: parseInt(support.resolved_tickets) || 0,
        avgResolutionTime: parseFloat(support.avg_resolution_time) || 0,
        satisfactionScore: parseFloat(support.avg_satisfaction) || 0,
      },
      trends: {
        interactionsByDay: interactionTrendsResult.rows.map((row) => ({
          date: row.date,
          count: parseInt(row.count),
        })),
        revenueByDay: revenueTrendsResult.rows.map((row) => ({
          date: row.date,
          amount: parseFloat(row.amount),
        })),
        topContacts: topContactsResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email,
          revenue: parseFloat(row.revenue),
          interactions: parseInt(row.interactions),
        })),
      },
    };
  }

  // Get revenue analytics with breakdown
  static async getRevenueAnalytics(
    userId,
    timeRange: 'day' | 'week' | 'month' | 'year' = 'month'
  ) {
    const dateFilter = this.getDateFilter(timeRange);

    // Revenue by platform
    const platformResult = await query(
      `SELECT 
        platform,
        COUNT(*)_count,
        SUM(order_total)_revenue,
        AVG(order_total)_order_value
       FROM commerce_data
       WHERE user_id = $1 AND order_date >= $2
       GROUP BY platform`,
      [userId, dateFilter]
    );

    // Revenue by customer segment
    const segmentResult = await query(
      `SELECT 
        c.relationship_type,
        COUNT(DISTINCT c.id)_count,
        SUM(cd.order_total)_revenue,
        AVG(cd.order_total)_order_value
       FROM contacts c
       JOIN commerce_data cd ON c.id = cd.contact_id
       WHERE c.user_id = $1 AND cd.order_date >= $2
       GROUP BY c.relationship_type`,
      [userId, dateFilter]
    );

    // Top products/items (from order items JSON)
    const topProductsResult = await query(
      `SELECT 
        item->>'name'_name,
        COUNT(*)_ordered,
        SUM((item->>'quantity')::int)_quantity,
        SUM((item->>'price')::numeric * (item->>'quantity')::int)_data,
       jsonb_array_elements(items)_id = $1 AND order_date >= $2
       GROUP BY item->>'name'
       ORDER BY revenue DESC
       LIMIT 10`,
      [userId, dateFilter]
    );

    return {
      byPlatform: platformResult.rows,
      bySegment: segmentResult.rows,
      topProducts: topProductsResult.rows,
    };
  }

  // Get interaction analytics
  static async getInteractionAnalytics(
    userId,
    timeRange: 'day' | 'week' | 'month' | 'year' = 'month'
  ) {
    const dateFilter = this.getDateFilter(timeRange);

    // Interactions by platform
    const platformResult = await query(
      `SELECT 
        platform,
        interaction_type,
        COUNT(*),
        COUNT(CASE WHEN direction = 'inbound' THEN 1 END),
        COUNT(CASE WHEN direction = 'outbound' THEN 1 END)_id = $1 AND occurred_at >= $2
       GROUP BY platform, interaction_type
       ORDER BY count DESC`,
      [userId, dateFilter]
    );

    // Sentiment analysis
    const sentimentResult = await query(
      `SELECT 
        sentiment,
        COUNT(*)_id = $1 AND occurred_at >= $2 AND sentiment IS NOT NULL
       GROUP BY sentiment`,
      [userId, dateFilter]
    );

    // Response time analysis
    const responseTimeResult = await query(
      `SELECT 
        AVG(EXTRACT(EPOCH FROM (
          i2.occurred_at - i1.occurred_at
        )) / 3600)_response_hours
       FROM interactions i1
       JOIN interactions i2 ON i1.contact_id = i2.contact_id
       WHERE i1.user_id = $1
         AND i1.direction = 'inbound'
         AND i2.direction = 'outbound'
         AND i2.occurred_at > i1.occurred_at
         AND i1.occurred_at >= $2`,
      [userId, dateFilter]
    );

    return {
      byPlatform: platformResult.rows,
      bySentiment: sentimentResult.rows,
      avgResponseTimeHours: parseFloat(responseTimeResult.rows[0]?.avg_response_hours || 0),
    };
  }

  // Get contact growth analytics
  static async getContactGrowth(
    userId,
    timeRange: 'day' | 'week' | 'month' | 'year' = 'month'
  ) {
    const dateFilter = this.getDateFilter(timeRange);

    const result = await query(
      `SELECT 
        DATE(created_at),
        COUNT(*)_contacts,
        COUNT(CASE WHEN relationship_type = 'customer' THEN 1 END)_customers,
        COUNT(CASE WHEN relationship_type = 'lead' THEN 1 END)_leads
       FROM contacts
       WHERE user_id = $1 AND created_at >= $2
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [userId, dateFilter]
    );

    return {
      growth: result.rows,
    };
  }

  // Get marketing attribution analytics
  static async getMarketingAttribution(userId) {
    const result = await query(
      `SELECT 
        ma.ad_platform,
        ma.source,
        ma.medium,
        COUNT(DISTINCT ma.contact_id),
        SUM(c.total_revenue)_revenue,
        AVG(ma.cost_per_acquisition)_cpa,
        SUM(c.total_revenue) / NULLIF(SUM(ma.cost_per_acquisition), 0)_attribution ma
       JOIN contacts c ON ma.contact_id = c.id
       WHERE ma.user_id = $1
       GROUP BY ma.ad_platform, ma.source, ma.medium
       ORDER BY total_revenue DESC`,
      [userId]
    );

    return {
      attribution: result.rows,
    };
  }

  // Helper: Get date filter based on time range
  private static getDateFilter(timeRange: 'day' | 'week' | 'month' | 'year') {
    const now = new Date();
    switch (timeRange) {
      case 'day':
        now.setDate(now.getDate() - 1);
        break;
      case 'week':
        now.setDate(now.getDate() - 7);
        break;
      case 'month':
        now.setMonth(now.getMonth() - 1);
        break;
      case 'year':
        now.setFullYear(now.getFullYear() - 1);
        break;
    }
    return now;
  }
}


module.exports = { AnalyticsService };
