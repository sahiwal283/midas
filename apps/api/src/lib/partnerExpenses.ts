import { z } from 'zod';

export const partnerExpenseCreateSchema = z.object({
  amount: z.number().positive().finite(),
  itemLocation: z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(300)),
  category: z.enum(['business', 'personal']).default('business'),
});

export type PartnerExpenseCreateInput = z.infer<typeof partnerExpenseCreateSchema>;
