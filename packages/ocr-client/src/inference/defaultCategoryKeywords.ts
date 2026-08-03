import type { CategoryKeywordMap } from '../types';

/**
 * Exact category keyword taxonomy from the verified Trade Show / expense-app
 * RuleBasedInferenceEngine. These names are OCR *suggestions* produced by the
 * shared pipeline — not Midas DB expense_categories rows. Changing this map
 * changes OCR results vs the expense app; do not edit lightly.
 */
export const DEFAULT_CATEGORY_KEYWORDS: CategoryKeywordMap = {
  'Booth / Marketing / Tools': {
    keywords: ['booth', 'display', 'banner', 'signage', 'marketing', 'promotion', 'brochure', 'flyer', 'tools', 'equipment'],
    weight: 1.0,
  },
  'Travel - Flight': {
    keywords: ['airline', 'airways', 'flight', 'aviation', 'airport', 'boarding', 'departure', 'arrival'],
    weight: 1.0,
  },
  'Accommodation - Hotel': {
    keywords: ['hotel', 'motel', 'inn', 'resort', 'marriott', 'hilton', 'hyatt', 'holiday inn', 'best western', 'lodging', 'accommodation', 'night', 'stay'],
    weight: 1.0,
  },
  'Transportation - Uber / Lyft / Others': {
    keywords: ['uber', 'lyft', 'taxi', 'cab', 'rideshare', 'ride-share', 'transport', 'your ride', 'trip with', 'pickup', 'drop-off', 'dropoff', 'driver'],
    weight: 1.0,
  },
  'Parking Fees': {
    keywords: ['parking', 'park', 'valet', 'garage'],
    weight: 1.0,
  },
  'Rental - Car / U-haul': {
    keywords: ['rental', 'hertz', 'enterprise', 'avis', 'budget', 'u-haul', 'uhaul', 'car hire', 'vehicle rental'],
    weight: 1.0,
  },
  'Meal and Entertainment': {
    keywords: ['restaurant', 'cafe', 'coffee', 'diner', 'bistro', 'grill', 'kitchen', 'bar', 'pub', 'food', 'dining', 'breakfast', 'lunch', 'dinner', 'meal', 'entertainment'],
    weight: 1.0,
  },
  'Gas / Fuel': {
    keywords: ['gas', 'fuel', 'gasoline', 'diesel', 'petrol', 'shell', 'bp', 'exxon', 'chevron', 'mobil'],
    weight: 1.0,
  },
  'Show Allowances - Per Diem': {
    keywords: ['per diem', 'allowance', 'daily allowance', 'show allowance'],
    weight: 1.0,
  },
  Model: {
    keywords: ['model', 'talent', 'contractor', 'appearance'],
    weight: 1.0,
  },
  'Shipping Charges': {
    keywords: ['shipping', 'freight', 'delivery', 'courier', 'fedex', 'ups', 'usps', 'dhl'],
    weight: 1.0,
  },
  Other: {
    keywords: ['misc', 'miscellaneous', 'other'],
    weight: 0.5,
  },
};
