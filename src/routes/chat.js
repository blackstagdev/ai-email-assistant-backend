const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { AIService } = require('../services/AIService');
const { query } = require('../db');
const { z } = require('zod');
const OpenAI = require('openai');

const router = Router();
router.use(authMiddleware);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Validation schema
const chatMessageSchema = z.object({
  message: z.string().min(1),
  conversationId: z.string().uuid().optional(),
});

// POST /api/chat - Send message to AI assistant
router.post('/', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { message, conversationId } = chatMessageSchema.parse(req.body);

    // Get context: user's recent data
    const contactsResult = await query(
      'SELECT COUNT(*) as count FROM contacts WHERE user_id = $1',
      [userId]
    );

    const interactionsResult = await query(
      `SELECT COUNT(*) as count FROM interactions 
       WHERE user_id = $1 AND occurred_at >= NOW() - INTERVAL '7 days'`,
      [userId]
    );

    const revenueResult = await query(
      `SELECT COALESCE(SUM(order_total), 0) as total 
       FROM commerce_data 
       WHERE user_id = $1 AND order_date >= NOW() - INTERVAL '30 days'`,
      [userId]
    );

    const draftsResult = await query(
      `SELECT COUNT(*) as count FROM draft_emails 
       WHERE user_id = $1 AND status = 'pending'`,
      [userId]
    );

    const platformsResult = await query(
      `SELECT platform FROM platform_integrations 
       WHERE user_id = $1 AND is_connected = true`,
      [userId]
    );

    // Get conversation history if continuing conversation
    let conversationHistory = [];
    if (conversationId) {
      const historyResult = await query(
        `SELECT role, content FROM analytics_events 
         WHERE user_id = $1 AND event_type = 'chat_message' 
         AND event_data->>'conversationId' = $2
         ORDER BY occurred_at ASC`,
        [userId, conversationId]
      );
      conversationHistory = historyResult.rows.map((row) => ({
        role: row.role,
        content: row.content,
      }));
    }

    // Build system context
    const systemContext = `You are an AI assistant integrated into a business intelligence platform. You have access to the user's data across multiple platforms and can help them with:

1. Analyzing their contacts and relationships
2. Drafting personalized emails
3. Answering questions about their business metrics
4. Searching through their conversation history
5. Providing insights about customers and revenue

Current user context:
- Total contacts: ${contactsResult.rows[0].count}
- Interactions this week: ${interactionsResult.rows[0].count}
- Revenue this month: $${parseFloat(revenueResult.rows[0].total).toFixed(2)}
- Pending draft emails: ${draftsResult.rows[0].count}
- Connected platforms: ${platformsResult.rows.map((r) => r.platform).join(', ')}

You can help the user by:
- Searching their contacts: "Find contacts who haven't been contacted in 30 days"
- Analyzing data: "What's my revenue trend this month?"
- Drafting emails: "Draft an email to John about the Q4 proposal"
- Answering questions about their business

Be helpful, concise, and use the context provided to give relevant answers.`;

    // Create messages array
    const messages = [
      {
        role: 'system',
        content,
      },
      ...conversationHistory,
      {
        role: 'user',
        content,
      },
    ];

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      temperature: 0.7,
      max_tokens: 1000,
    });

    const assistantResponse = completion.choices[0].message.content || 'I apologize, I could not generate a response.';

    // Store conversation in analytics_events
    const newConversationId = conversationId || require('uuid').v4();
    
    await query(
      `INSERT INTO analytics_events (user_id, event_type, event_data)
       VALUES ($1, 'chat_message', $2)`,
      [
        userId,
        JSON.stringify({
          conversationId,
          role: 'user',
          content,
        }),
      ]
    );

    await query(
      `INSERT INTO analytics_events (user_id, event_type, event_data)
       VALUES ($1, 'chat_message', $2)`,
      [
        userId,
        JSON.stringify({
          conversationId,
          role: 'assistant',
          content,
        }),
      ]
    );

    res.json({
      message,
      conversationId,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error in chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/chat/history - Get chat conversation history
router.get('/history', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.query;

    let historyQuery;
    let params = [];

    if (conversationId) {
      historyQuery = `
        SELECT event_data, occurred_at
        FROM analytics_events
        WHERE user_id = $1 
          AND event_type = 'chat_message'
          AND event_data->>'conversationId' = $2
        ORDER BY occurred_at ASC
      `;
      params = [userId, conversationId];
    } else {
      // Get all conversations grouped
      historyQuery = `
        SELECT DISTINCT event_data->>'conversationId' as conversation_id,
               MIN(occurred_at) as started_at,
               MAX(occurred_at) as last_message_at,
               COUNT(*) as message_count
        FROM analytics_events
        WHERE user_id = $1 AND event_type = 'chat_message'
        GROUP BY event_data->>'conversationId'
        ORDER BY last_message_at DESC
        LIMIT 20
      `;
      params = [userId];
    }

    const result = await query(historyQuery, params);

    res.json({
      history: result.rows,
    });
  } catch (error) {
    console.error('Error fetching chat history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/chat/search - Semantic search through interactions
router.post('/search', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { query: searchQuery } = req.body;

    if (!searchQuery || typeof searchQuery !== 'string') {
      return res.status(400).json({ error: 'Search query required' });
    }

    // Use AI service for semantic search
    const results = await AIService.searchSimilarInteractions(userId, searchQuery, 10);

    res.json({ results });
  } catch (error) {
    console.error('Error in semantic search:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/chat/:conversationId - Delete conversation
router.delete('/:conversationId', async (req, res) => {
  try {
    const userId = req.user.userId;
    const { conversationId } = req.params;

    await query(
      `DELETE FROM analytics_events 
       WHERE user_id = $1 
         AND event_type = 'chat_message' 
         AND event_data->>'conversationId' = $2`,
      [userId, conversationId]
    );

    res.json({ message: 'Conversation deleted successfully' });
  } catch (error) {
    console.error('Error deleting conversation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
