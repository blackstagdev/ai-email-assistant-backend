const { Router, Response } = require('express');
const { AuthRequest, authMiddleware } = require('../middleware/auth');
const { ContactService } = require('../services/ContactService');
const { z } = require('zod');

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// Validation schemas
const createContactSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
  jobTitle: z.string().optional(),
  relationshipType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.any()).optional(),
});

const updateContactSchema = createContactSchema.extend({
  relationshipStrength: z.number().min(0).max(100).optional(),
  customerLifetimeValue: z.number().optional(),
  totalRevenue: z.number().optional(),
}).partial();

// GET /api/contacts - List all contacts with pagination and filtering
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const {
      limit = '50',
      offset = '0',
      search,
      relationshipType,
    } = req.query;

    const result = await ContactService.getContactsByUser(userId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      search: search,
      relationshipType: relationshipType,
    });

    res.json({
      contacts: result.contacts,
      total: result.total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/contacts/search - Search contacts
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { q } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query required' });
    }

    const contacts = await ContactService.searchContacts(userId, q);
    res.json({ contacts });
  } catch (error) {
    console.error('Error searching contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/contacts/:id - Get single contact with full details
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const contact = await ContactService.getContactById(userId, id);

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Get platform identities
    const platformIdentities = await ContactService.getPlatformIdentities(id);

    res.json({
      contact,
      platformIdentities,
    });
  } catch (error) {
    console.error('Error fetching contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/contacts - Create new contact
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const data = createContactSchema.parse(req.body);

    const contact = await ContactService.createContact(userId, data);

    res.status(201).json({ contact });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/contacts/:id - Update contact
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const data = updateContactSchema.parse(req.body);

    const contact = await ContactService.updateContact(userId, id, data);

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ contact });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: error.errors });
    }
    console.error('Error updating contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/contacts/:id - Delete contact
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    const deleted = await ContactService.deleteContact(userId, id);

    if (!deleted) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    res.json({ message: 'Contact deleted successfully' });
  } catch (error) {
    console.error('Error deleting contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/contacts/:id/interactions - Get contact's interaction history
router.get('/:id/interactions', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    const { limit = '50', offset = '0' } = req.query;

    // Verify contact belongs to user
    const contact = await ContactService.getContactById(userId, id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    // Get interactions
    const { query } = await import('../db');
    const result = await query(
      `SELECT * FROM interactions 
       WHERE contact_id = $1 
       ORDER BY occurred_at DESC 
       LIMIT $2 OFFSET $3`,
      [id, parseInt(limit), parseInt(offset)]
    );

    res.json({ interactions: result.rows });
  } catch (error) {
    console.error('Error fetching interactions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/contacts/:id/timeline - Get unified timeline of all activity
router.get('/:id/timeline', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;

    // Verify contact belongs to user
    const contact = await ContactService.getContactById(userId, id);
    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const { query } = await import('../db');

    // Get all activity types for this contact
    const interactions = await query(
      `SELECT id, platform, interaction_type, subject, occurred_at, 
              'interaction' as category
       FROM interactions WHERE contact_id = $1`,
      [id]
    );

    const orders = await query(
      `SELECT id, platform, order_total, order_date,
              'order' as category
       FROM commerce_data WHERE contact_id = $1`,
      [id]
    );

    const tickets = await query(
      `SELECT id, platform, subject, created_at,
              'support_ticket', status
       FROM support_tickets WHERE contact_id = $1`,
      [id]
    );

    const tasks = await query(
      `SELECT id, platform, title, created_at,
              'task', status
       FROM tasks_projects WHERE contact_id = $1`,
      [id]
    );

    // Combine and sort by timestamp
    const timeline = [
      ...interactions.rows,
      ...orders.rows,
      ...tickets.rows,
      ...tasks.rows,
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({ timeline });
  } catch (error) {
    console.error('Error fetching timeline:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
