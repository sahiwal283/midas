import { z } from 'zod';

export const lineItemSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1),
  quantity: z.coerce.number().positive(),
  unit: z.string().optional().nullable(),
  unitPrice: z.coerce.number().nonnegative(),
  tax: z.coerce.number().nonnegative().optional().default(0),
  total: z.coerce.number().nonnegative(),
  zohoItemId: z.string().optional().nullable(),
  ocrConfidence: z.coerce.number().min(0).max(1).optional().nullable(),
  needsReview: z.boolean().optional(),
});

// vendorName may be empty: a draft is created the moment a receipt is picked,
// before OCR has read the vendor off it. poSubmitBlocker holds the real line —
// nothing reaches Zoho without a vendor.
export const createPoSchema = z.object({
  vendorName: z.string().default(''),
  transactionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3).default('USD'),
  taxTotal: z.coerce.number().nonnegative().optional().default(0),
  total: z.coerce.number().nonnegative().optional(),
  description: z.string().optional().nullable(),
  zohoEntity: z.string().optional().nullable(),
  zohoVendorId: z.string().optional().nullable(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().optional().nullable(),
  lineItems: z.array(lineItemSchema).default([]),
});

// `poNumber` is deliberately absent: it is no longer user input. Zoho assigns
// the number and Midas records what it assigned — that write belongs in
// zohoPoPush, next to the zohoRecordId write, not on a client-facing route.
export const updatePoSchema = createPoSchema.partial().extend({
  lineItems: z.array(lineItemSchema).optional(),
});
