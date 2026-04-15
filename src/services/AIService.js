const OpenAI = require('openai');
const { query } = require('../db');
const { ContactService } = require('./ContactService');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});





class AIService {
  // Generate email draft with full context
  static async generateEmailDraft(
    userId,
    context) {
    const { contactId, originalMessageId, userPrompt, tone = 'professional' } = context;

    // Get contact details
    const contact = await ContactService.getContactById(userId, contactId);
    if (!contact) {
      throw new Error('Contact not found');
    }

    // Get recent interactions
    const interactionsResult = await query(
      `SELECT subject, content, direction, occurred_at, sentiment
       FROM interactions
       WHERE contact_id = $1
       ORDER BY occurred_at DESC
       LIMIT 10`,
      [contactId]
    );

    // Get communication pattern
    const patternResult = await query(
      `SELECT * FROM communication_patterns WHERE contact_id = $1`,
      [contactId]
    );

    // Get original message if replying
    let originalMessage = null;
    if (originalMessageId) {
      const msgResult = await query(
        'SELECT * FROM interactions WHERE id = $1',
        [originalMessageId]
      );
      originalMessage = msgResult.rows[0];
    }

    // Get recent orders/purchases
    const ordersResult = await query(
      `SELECT order_total, order_date, fulfillment_status
       FROM commerce_data
       WHERE contact_id = $1
       ORDER BY order_date DESC
       LIMIT 5`,
      [contactId]
    );

    // Get support tickets
    const ticketsResult = await query(
      `SELECT subject, status, priority, created_at
       FROM support_tickets
       WHERE contact_id = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [contactId]
    );

    // Build context for AI
    const contextPrompt = this.buildContextPrompt({
      contact,
      interactions: interactionsResult.rows,
      communicationPattern: patternResult.rows[0],
      originalMessage,
      orders: ordersResult.rows,
      tickets: ticketsResult.rows,
      userPrompt,
      tone,
    });

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an AI email assistant helping draft professional, personalized emails. 
You have access to complete contact history, communication patterns, and business context.
Your goal is to write emails that match the user's tone and the contact's communication style.
Always be helpful, concise, and contextually aware.`,
        },
        {
          role: 'user',
          content: contextPrompt,
        },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    });

    const response = JSON.parse(completion.choices[0].message.content || '{}');

    return {
      subject: response.subject || 'Re: Follow up',
      body: response.body || '',
      reasoning: response.reasoning || 'Generated based on context',
      suggestedAttachments: response.suggested_attachments || [],
    };
  }

  // Build comprehensive context prompt
  private static buildContextPrompt(data) {
    const {
      contact,
      interactions,
      communicationPattern,
      originalMessage,
      orders,
      tickets,
      userPrompt,
      tone,
    } = data;

    let prompt = `Draft an email to ${contact.first_name} ${contact.last_name} (${contact.email}).\n\n`;

    // Add user's specific request
    if (userPrompt) {
      prompt += `USER REQUEST: ${userPrompt}\n\n`;
    }

    // Contact information
    prompt += `CONTACT DETAILS:
- Name: ${contact.first_name} ${contact.last_name}
- Company: ${contact.company || 'N/A'}
- Relationship: ${contact.relationship_type || 'unknown'}
- Total Revenue: $${contact.total_revenue || 0}
- Relationship Strength: ${contact.relationship_strength}/100\n\n`;

    // Communication pattern
    if (communicationPattern) {
      prompt += `COMMUNICATION STYLE:
- Formality: ${communicationPattern.formality_level || 'medium'}
- Typical Length: ${communicationPattern.typical_email_length || 'medium'}
- Uses Greetings: ${communicationPattern.uses_greetings ? 'yes' : 'no'}
- Uses Signoffs: ${communicationPattern.uses_signoffs ? 'yes' : 'no'}
- Emoji Usage: ${communicationPattern.emoji_usage ? 'yes' : 'no'}\n\n`;
    }

    // Recent interactions
    if (interactions.length > 0) {
      prompt += `RECENT EMAIL HISTORY:\n`;
      interactions.slice(0, 5).forEach((interaction: any, idx: number) => {
        prompt += `${idx + 1}. [${interaction.direction}] ${interaction.subject} - ${interaction.sentiment || 'neutral'} (${new Date(interaction.occurred_at).toLocaleDateString()})\n`;
      });
      prompt += '\n';
    }

    // Original message (if replying)
    if (originalMessage) {
      prompt += `REPLYING TO:
Subject: ${originalMessage.subject}
From: ${contact.first_name} ${contact.last_name}
Date: ${new Date(originalMessage.occurred_at).toLocaleDateString()}
Message: ${originalMessage.content?.substring(0, 500)}...\n\n`;
    }

    // Recent orders
    if (orders.length > 0) {
      prompt += `RECENT ORDERS:\n`;
      orders.forEach((order: any, idx: number) => {
        prompt += `${idx + 1}. $${order.order_total} on ${new Date(order.order_date).toLocaleDateString()} - ${order.fulfillment_status}\n`;
      });
      prompt += '\n';
    }

    // Support tickets
    if (tickets.length > 0) {
      prompt += `SUPPORT TICKETS:\n`;
      tickets.forEach((ticket: any, idx: number) => {
        prompt += `${idx + 1}. ${ticket.subject} - ${ticket.status} (${ticket.priority})\n`;
      });
      prompt += '\n';
    }

    prompt += `TONE: ${tone}\n\n`;

    prompt += `Generate a response in JSON format with these fields:
{
  "subject": "Email subject line",
  "body": "Full email body in HTML format",
  "reasoning": "Brief explanation of why you wrote it this way",
  "suggested_attachments": ["Optional array of file names that might be relevant"]
}

Make the email personalized, contextually aware, and match the communication style.`;

    return prompt;
  }

  // Analyze email sentiment and intent
  static async analyzeEmail(emailContent) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Use cheaper model for analysis
      messages: [
        {
          role: 'system',
          content: 'Analyze this email and extract sentiment, intent, topics, and action items. Return JSON only.',
        },
        {
          role: 'user',
          content: emailContent,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const analysis = JSON.parse(completion.choices[0].message.content || '{}');

    return {
      sentiment: analysis.sentiment || 'neutral',
      intent: analysis.intent || 'general',
      topics: analysis.topics || [],
      actionItems: analysis.action_items || [],
    };
  }

  // Classify contact relationship
  static async classifyRelationship(contactData: number;
    totalRevenue;
    supportTickets;
    communicationFrequency;
  }) {
    const prompt = `Based on this data, classify the relationship type and strength (0-100):
- Total interactions: ${contactData.interactions}
- Total revenue: $${contactData.totalRevenue}
- Support tickets: ${contactData.supportTickets}
- Communication frequency: ${contactData.communicationFrequency}

Return JSON: { "relationship_type": "customer|lead|partner|colleague|vendor", "relationship_strength": 0-100 }`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You classify business relationships based on interaction data.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const classification = JSON.parse(completion.choices[0].message.content || '{}');

    return {
      relationshipType: classification.relationship_type || 'unknown',
      relationshipStrength: classification.relationship_strength || 50,
    };
  }

  // Generate embeddings for semantic search
  static async generateEmbedding(text) {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });

    return response.data[0].embedding;
  }

  // Search similar interactions using embeddings
  static async searchSimilarInteractions(
    userId,
    queryText,
    limit= 10
  ) {
    const queryEmbedding = await this.generateEmbedding(queryText);

    // Use pgvector for similarity search
    const result = await query(
      `SELECT i.*, c.first_name, c.last_name, c.email,
              (embedding <=> $1::vector) as distance
       FROM interactions i
       JOIN contacts c ON i.contact_id = c.id
       WHERE i.user_id = $2
       ORDER BY embedding <=> $1::vector
       LIMIT $3`,
      [`[${queryEmbedding.join(',')}]`, userId, limit]
    );

    return result.rows;
  }

  // Summarize conversation thread
  static async summarizeThread(threadId) {
    const messagesResult = await query(
      `SELECT subject, content, direction, occurred_at
       FROM interactions
       WHERE id IN (
         SELECT id FROM interactions WHERE id = $1
         UNION
         SELECT id FROM interactions WHERE subject LIKE (
           SELECT '%' || subject || '%' FROM interactions WHERE id = $1
         )
       )
       ORDER BY occurred_at ASC`,
      [threadId]
    );

    const messages = messagesResult.rows;
    const conversationText = messages
      .map((m: any) => `[${m.direction}] ${m.content}`)
      .join('\n\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Summarize this email conversation concisely, highlighting key points and outcomes.',
        },
        {
          role: 'user',
          content: conversationText,
        },
      ],
      temperature: 0.3,
      max_tokens: 300,
    });

    return completion.choices[0].message.content || 'Unable to generate summary';
  }

  // Extract action items from text
  static async extractActionItems(text) {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Extract action items from this text. Return a JSON array of action items.',
        },
        {
          role: 'user',
          content: text,
        },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const result = JSON.parse(completion.choices[0].message.content || '{}');
    return result.action_items || [];
  }
}


module.exports = { AIService };
