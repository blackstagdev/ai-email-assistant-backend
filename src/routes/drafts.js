const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { AIService } = require('../services/AIService');
const { query } = require('../db');
const { z } = require('zod');

const router = Router();
router.use(authMiddleware);

// Validation schemas
const generateDraftSchema = z.object({
  contactId: z.string().uuid(),
  originalMessageId: z.string().uuid().optional(),
  userPrompt: z.string().optional(),
  tone: z.enum(['professional', 'casual', 'friendly', 'formal']).optional(),
});

const approveDraftSchema = z.object({
  edits: z.string().optional(),
});

const rejectDraftSchema = z.object({
  feedback: z.string(),
});

const rewriteDraftSchema = z.object({
  feedback: z.string(),
  tone: z.enum(['professional', 'casual', 'friendly', 'formal']).optional(),
});

// GET /api/drafts - List all draft emails
router.get('/', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { status = 'pending', limit = '50', offset = '0' } = req.query;

    const result = await query(
      `SELECT d.*, c.first_name, c.last_name, c.email, c.company
       FROM draft_emails d
       JOIN contacts c ON d.contact_id = c.id
       WHERE d.user_id = $1 AND d.status = $2
       ORDER BY d.created_at DESC
       LIMIT $3 OFFSET $4`,
      [userId, status, parseInt(limit), parseInt(offset)]
    );

    res.json({ drafts: result.rows });
  } catch (error) {
    console.error('Error fetching drafts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/drafts/:id - Get single draft
router.get('/:id', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const result = await query(
      `SELECT d.*, c.first_name, c.last_name, c.email, c.company
       FROM draft_emails d
       JOIN contacts c ON d.contact_id = c.id
       WHERE d.id = $1 AND d.user_id = $2`,
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json({ draft: result.rows[0] });
  } catch (error) {
    console.error('Error fetching draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/drafts/generate - Generate new AI draft
router.post('/generate', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const data = generateDraftSchema.parse(req.body);

    // Generate draft using AI
    const draft = await AIService.generateEmailDraft(userId, {
      contactId: data.contactId,
      originalMessageId: data.originalMessageId,
      userPrompt: data.userPrompt,
      tone: data.tone,
    });

    // Save draft to database
    const result = await query(
      `INSERT INTO draft_emails (
        user_id, contact_id, original_message_id, subject, 
        draft_content, context_used, status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending')
      RETURNING *`,
      [
        userId,
        data.contactId,
        data.originalMessageId || null,
        draft.subject,
        draft.body,
        JSON.stringify({
          tone: data.tone,
          userPrompt: data.userPrompt,
          reasoning: draft.reasoning,
          suggestedAttachments: draft.suggestedAttachments,
        }),
      ]
    );

    res.status(201).json({
      draft: result.rows[0],
      reasoning: draft.reasoning,
      suggestedAttachments: draft.suggestedAttachments,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error generating draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/drafts/:id/approve - Approve draft (optionally with edits)
router.put('/:id/approve', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const { edits } = approveDraftSchema.parse(req.body);

    const result = await query(
      `UPDATE draft_emails
       SET status = 'approved',
           user_edits = $1,
           approved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [edits || null, id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json({ draft: result.rows[0], message: 'Draft approved successfully' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error approving draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/drafts/:id/reject - Reject draft with feedback
router.put('/:id/reject', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const { feedback } = rejectDraftSchema.parse(req.body);

    const result = await query(
      `UPDATE draft_emails
       SET status = 'rejected',
           user_feedback = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [feedback, id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json({ draft: result.rows[0], message: 'Draft rejected' });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error rejecting draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/drafts/:id/rewrite - Request AI to rewrite with feedback
router.post('/:id/rewrite', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const { feedback, tone } = rewriteDraftSchema.parse(req.body);

    // Get original draft
    const originalResult = await query(
      'SELECT * FROM draft_emails WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (originalResult.rows.length === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    const originalDraft = originalResult.rows[0];

    // Generate new draft with feedback incorporated
    const newDraft = await AIService.generateEmailDraft(userId, {
      contactId: originalDraft.contact_id,
      originalMessageId: originalDraft.original_message_id,
      userPrompt: `Previous draft feedback: ${feedback}\n\nOriginal draft:\n${originalDraft.draft_content}`,
      tone,
    });

    // Update draft with new content
    const result = await query(
      `UPDATE draft_emails
       SET draft_content = $1,
           subject = $2,
           user_feedback = $3,
           context_used = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [
        newDraft.body,
        newDraft.subject,
        feedback,
        JSON.stringify({
          tone,
          feedback,
          reasoning: newDraft.reasoning,
          suggestedAttachments: newDraft.suggestedAttachments,
        }),
        id,
        userId,
      ]
    );

    res.json({
      draft: result.rows[0],
      reasoning: newDraft.reasoning,
      message: 'Draft rewritten successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error rewriting draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/drafts/:id/send - Send approved draft via email
router.post('/:id/send', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    // Get draft
    const draftResult = await query(
      `SELECT d.*, c.email as contact_email
       FROM draft_emails d
       JOIN contacts c ON d.contact_id = c.id
       WHERE d.id = $1 AND d.user_id = $2 AND d.status = 'approved'`,
      [id, userId]
    );

    if (draftResult.rows.length === 0) {
      return res.status(404).json({ error: 'Approved draft not found' });
    }

    const draft = draftResult.rows[0];

    // Use Microsoft Service to send email
    const { MicrosoftService } = await import('../services/MicrosoftService');
    
    const finalBody = draft.user_edits || draft.draft_content;

    await MicrosoftService.sendEmail(
      userId,
      [draft.contact_email],
      draft.subject,
      finalBody
    );

    // Mark as sent
    await query(
      `UPDATE draft_emails
       SET status = 'sent',
           sent_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [id]
    );

    // Record as interaction
    await query(
      `INSERT INTO interactions (
        contact_id, user_id, platform, interaction_type, direction,
        subject, content, occurred_at
      ) VALUES ($1, $2, 'microsoft', 'email', 'outbound', $3, $4, CURRENT_TIMESTAMP)`,
      [draft.contact_id, userId, draft.subject, finalBody]
    );

    res.json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Error sending email:', error);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

// DELETE /api/drafts/:id - Delete draft
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const result = await query(
      'DELETE FROM draft_emails WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Draft not found' });
    }

    res.json({ message: 'Draft deleted successfully' });
  } catch (error) {
    console.error('Error deleting draft:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
