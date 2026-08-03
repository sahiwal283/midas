/**
 * Rule-Based Inference Engine
 *
 * Verbatim port of the Trade Show / expense-app engine
 * (trade-show-app/backend/src/services/ocr/inference/RuleBasedInferenceEngine.ts).
 * Do not "improve" or generalize the heuristics here — OCR result parity with the
 * verified expense-app pipeline depends on this file staying byte-for-byte equivalent
 * in behavior. Category keyword overrides are optional for tests only.
 */

import type {
  CategoryKeywordMap,
  CategorySuggestion,
  FieldInference,
  FieldValue,
  InferredOcrResult,
} from '../types';
import { DEFAULT_CATEGORY_KEYWORDS } from './defaultCategoryKeywords';

/** Alias matching the expense-app's OCRResult shape used by this engine. */
type OCRResult = InferredOcrResult;

export class RuleBasedInferenceEngine {
  name = 'rule-based';

  // Category keywords with weights — defaults are the expense-app taxonomy.
  private categoryKeywords: CategoryKeywordMap;

  constructor(categoryKeywords: CategoryKeywordMap = DEFAULT_CATEGORY_KEYWORDS) {
    this.categoryKeywords = categoryKeywords;
  }
  
  // Common card types and patterns
  private cardPatterns = [
    { pattern: /\*+(\d{4})/i, confidence: 0.9 },
    { pattern: /x{4,}(\d{4})/i, confidence: 0.9 },
    { pattern: /ending\s+(?:in\s+)?(\d{4})/i, confidence: 0.95 },
    { pattern: /card\s+(?:no\.?|number)?\s*\*+(\d{4})/i, confidence: 0.95 },
    { pattern: /(?:visa|mastercard|amex|discover)\s+\*+(\d{4})/i, confidence: 1.0 }
  ];
  
  /**
   * Infer fields from OCR result
   */
  async infer(ocrResult: OCRResult): Promise<FieldInference> {
    const text = ocrResult.text;
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const textLower = text.toLowerCase();
    
    console.log('[Inference] Starting field extraction...');
    
    return {
      merchant: this.extractMerchant(lines, ocrResult.confidence),
      amount: this.extractAmount(text, textLower, ocrResult.confidence),
      date: this.extractDate(text, ocrResult.confidence),
      cardLastFour: this.extractCardLastFour(text, textLower, ocrResult.confidence),
      category: this.predictCategory(textLower, ocrResult.confidence),
      location: this.extractLocation(text, ocrResult.confidence),
      taxAmount: this.extractTaxAmount(text, textLower, ocrResult.confidence),
      tipAmount: this.extractTipAmount(text, textLower, ocrResult.confidence)
    };
  }
  
  /**
   * Extract merchant name (usually first substantial line)
   */
  private extractMerchant(lines: string[], ocrConfidence: number): FieldValue<string> {
    const fullText = lines.join(' ').toLowerCase();
    
    // Check for contextual patterns (even if brand name isn't explicit)
    const contextualMerchants = [
      { pattern: /your ride to|trip with|pickup.*drop[-\s]?off/i, name: 'Uber', confidence: 0.92 },
      { pattern: /lyft ride|lyft trip/i, name: 'Lyft', confidence: 0.93 }
    ];
    
    for (const { pattern, name, confidence } of contextualMerchants) {
      if (pattern.test(fullText)) {
        console.log(`[Inference] Merchant: "${name}" (contextual match, confidence: ${confidence.toFixed(2)})`);
        return {
          value: name,
          confidence,
          source: 'inference',
          rawText: 'Detected from receipt context'
        };
      }
    }
    
    // Check for known brands/merchants explicitly mentioned
    const knownMerchants = [
      { pattern: /\blyft\b/i, name: 'Lyft', confidence: 0.95 },
      { pattern: /\buber\b/i, name: 'Uber', confidence: 0.95 },
      { pattern: /\bstarbucks\b/i, name: 'Starbucks', confidence: 0.95 },
      { pattern: /\bmcdonalds?\b/i, name: 'McDonalds', confidence: 0.95 },
      { pattern: /\bwalmart\b/i, name: 'Walmart', confidence: 0.95 },
      { pattern: /\btarget\b/i, name: 'Target', confidence: 0.95 },
      { pattern: /\bamazon\b/i, name: 'Amazon', confidence: 0.95 },
      { pattern: /\bmarriott\b/i, name: 'Marriott', confidence: 0.95 },
      { pattern: /\bhilton\b/i, name: 'Hilton', confidence: 0.95 },
      { pattern: /\bhyatt\b/i, name: 'Hyatt', confidence: 0.95 }
    ];
    
    for (const { pattern, name, confidence } of knownMerchants) {
      if (pattern.test(fullText)) {
        console.log(`[Inference] Merchant: "${name}" (known brand, confidence: ${confidence.toFixed(2)})`);
        return {
          value: name,
          confidence,
          source: 'inference',
          rawText: lines.find(l => pattern.test(l))
        };
      }
    }
    
    // Fall back to extracting first substantial line
    for (const line of lines.slice(0, 8)) {
      const trimmed = line.trim();
      // Skip lines that are just numbers, dates, or common headers
      if (trimmed.length > 3 && 
          !/^\d+$/.test(trimmed) && 
          !/^receipt$/i.test(trimmed) &&
          !/^invoice$/i.test(trimmed) &&
          !/^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(trimmed)) {
        
        const confidence = Math.min(0.7 + (ocrConfidence * 0.3), 0.95);
        console.log(`[Inference] Merchant: "${trimmed}" (confidence: ${confidence.toFixed(2)})`);
        
        return {
          value: trimmed,
          confidence,
          source: 'inference',
          rawText: line
        };
      }
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Extract amount with multiple patterns and currency support
   */
  private extractAmount(text: string, textLower: string, ocrConfidence: number): FieldValue<number> {
    const patterns = [
      // High confidence patterns (specific keywords)
      { regex: /(?:grand[\s]+)?total[\s:]*(?:\$|USD|€|EUR|£|GBP)?\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/i, confidence: 0.98 },
      { regex: /amount[\s]*(?:due|paid|charged)?[\s:]*(?:\$|USD|€|EUR|£|GBP)?\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/i, confidence: 0.92 },
      { regex: /balance[\s]*(?:due)?[\s:]*(?:\$|USD|€|EUR|£|GBP)?\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/i, confidence: 0.88 },
      
      // Medium confidence patterns (contextual)
      { regex: /(?:\$|USD|€|EUR|£|GBP)\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)\s*(?:total|amount|balance|due|paid)/i, confidence: 0.90 },
      { regex: /pay[\s:]*(?:\$|USD|€|EUR|£|GBP)?\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/i, confidence: 0.85 },
      { regex: /charged[\s:]*(?:\$|USD|€|EUR|£|GBP)?\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/i, confidence: 0.85 },
      
      // Lower confidence patterns (standalone currency amounts)
      { regex: /(?:\$|USD)\s*(\d{1,3}(?:,\d{3})*\.\d{2})\b/g, confidence: 0.70 }, // Must have decimal for standalone
      { regex: /(?:€|EUR)\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/g, confidence: 0.70 },
      { regex: /(?:£|GBP)\s*(\d{1,3}(?:,\d{3})*(?:[.,]\d{2})?)/g, confidence: 0.70 }
    ];
    
    const alternatives: Array<{ value: number; confidence: number; rawText: string }> = [];
    
    for (const { regex, confidence: patternConf } of patterns) {
      if (regex.global) {
        // Handle global patterns (multiple matches)
        let match;
        while ((match = regex.exec(text)) !== null) {
          const normalized = this.normalizeAmount(match[1]);
          if (normalized && normalized >= 0.01 && normalized <= 100000) {
            const finalConfidence = Math.min(patternConf * ocrConfidence, 0.98);
            
            if (!alternatives.find(a => Math.abs(a.value - normalized) < 0.01)) {
              alternatives.push({ 
                value: normalized, 
                confidence: finalConfidence,
                rawText: match[0]
              });
            }
          }
        }
      } else {
        // Handle single match patterns
        const match = text.match(regex);
        if (match) {
          const normalized = this.normalizeAmount(match[1]);
          if (normalized && normalized >= 0.01 && normalized <= 100000) {
            const finalConfidence = Math.min(patternConf * ocrConfidence, 0.98);
            
            if (!alternatives.find(a => Math.abs(a.value - normalized) < 0.01)) {
              alternatives.push({ 
                value: normalized, 
                confidence: finalConfidence,
                rawText: match[0]
              });
            }
          }
        }
      }
    }
    
    // Sort by confidence and return best match
    alternatives.sort((a, b) => b.confidence - a.confidence);
    
    if (alternatives.length > 0) {
      const best = alternatives[0];
      console.log(`[Inference] Amount: $${best.value.toFixed(2)} (confidence: ${best.confidence.toFixed(2)})`);
      if (alternatives.length > 1) {
        console.log(`[Inference] Alternatives: ${alternatives.slice(1, 3).map(a => `$${a.value.toFixed(2)}`).join(', ')}`);
      }
      
      return {
        value: best.value,
        confidence: best.confidence,
        source: 'inference',
        rawText: best.rawText,
        alternatives: alternatives.slice(1, 3).map(a => ({ value: a.value, confidence: a.confidence }))
      };
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Normalize amount string to number (handles commas, periods, etc.)
   */
  private normalizeAmount(amountStr: string): number | null {
    try {
      // Remove spaces
      let normalized = amountStr.replace(/\s/g, '');
      
      // Handle European format (comma as decimal separator)
      // If there's a period for thousands and comma for decimal: 1.234,56 -> 1234.56
      if (/\d+\.\d{3},\d{2}/.test(normalized)) {
        normalized = normalized.replace(/\./g, '').replace(',', '.');
      }
      // If there's only a comma as decimal separator: 123,45 -> 123.45
      else if (/^\d+,\d{2}$/.test(normalized)) {
        normalized = normalized.replace(',', '.');
      }
      // Handle US format (comma as thousands separator): 1,234.56
      else {
        normalized = normalized.replace(/,/g, '');
      }
      
      const parsed = parseFloat(normalized);
      return isNaN(parsed) ? null : parsed;
    } catch {
      return null;
    }
  }
  
  /**
   * Extract date with multiple formats and normalize to ISO (YYYY-MM-DD)
   */
  private extractDate(text: string, ocrConfidence: number): FieldValue<string> {
    const patterns = [
      // ISO format (highest confidence)
      { regex: /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,  confidence: 0.98, format: 'ISO' },
      
      // US format with various keywords
      { regex: /(?:date|on|dated)[\s:]*(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i,  confidence: 0.95, format: 'MM/DD/YYYY' },
      { regex: /(\d{1,2}[-/]\d{1,2}[-/]\d{4})/,  confidence: 0.90, format: 'MM/DD/YYYY' },
      { regex: /(\d{1,2}[-/]\d{1,2}[-/]\d{2})/,  confidence: 0.85, format: 'MM/DD/YY' },
      
      // Written month formats
      { regex: /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i, confidence: 0.98, format: 'Month DD, YYYY' },
      { regex: /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i, confidence: 0.95, format: 'Mon DD, YYYY' },
      { regex: /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i, confidence: 0.98, format: 'DD Month YYYY' },
      { regex: /(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})/i, confidence: 0.95, format: 'DD Mon YYYY' }
    ];
    
    for (const { regex, confidence: patternConf, format } of patterns) {
      const match = text.match(regex);
      if (match) {
        const rawDate = match[1] || match[0];
        const normalized = this.normalizeDate(rawDate, format);
        
        if (normalized) {
          const finalConfidence = Math.min(patternConf * ocrConfidence, 0.98);
          console.log(`[Inference] Date: ${rawDate} -> ${normalized} (confidence: ${finalConfidence.toFixed(2)})`);
          
          return {
            value: normalized, // ISO format: YYYY-MM-DD
            confidence: finalConfidence,
            source: 'inference',
            rawText: rawDate
          };
        }
      }
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Normalize date string to ISO format (YYYY-MM-DD)
   */
  private normalizeDate(dateStr: string, format: string): string | null {
    try {
      const monthMap: { [key: string]: string } = {
        'jan': '01', 'january': '01',
        'feb': '02', 'february': '02',
        'mar': '03', 'march': '03',
        'apr': '04', 'april': '04',
        'may': '05',
        'jun': '06', 'june': '06',
        'jul': '07', 'july': '07',
        'aug': '08', 'august': '08',
        'sep': '09', 'september': '09',
        'oct': '10', 'october': '10',
        'nov': '11', 'november': '11',
        'dec': '12', 'december': '12'
      };
      
      if (format === 'ISO') {
        // Already in YYYY-MM-DD or YYYY/MM/DD format
        const [year, month, day] = dateStr.split(/[-/]/).map(s => s.padStart(2, '0'));
        return `${year}-${month}-${day}`;
      }
      
      if (format === 'MM/DD/YYYY') {
        const [month, day, year] = dateStr.split(/[-/]/);
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
      
      if (format === 'MM/DD/YY') {
        const [month, day, year] = dateStr.split(/[-/]/);
        const fullYear = parseInt(year) < 50 ? `20${year}` : `19${year}`;
        return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
      
      if (format === 'Month DD, YYYY' || format === 'Mon DD, YYYY') {
        const match = dateStr.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
        if (match) {
          const [, monthStr, day, year] = match;
          const month = monthMap[monthStr.toLowerCase()];
          if (month) {
            return `${year}-${month}-${day.padStart(2, '0')}`;
          }
        }
      }
      
      if (format === 'DD Month YYYY' || format === 'DD Mon YYYY') {
        const match = dateStr.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
        if (match) {
          const [, day, monthStr, year] = match;
          const month = monthMap[monthStr.toLowerCase()];
          if (month) {
            return `${year}-${month}-${day.padStart(2, '0')}`;
          }
        }
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  /**
   * Extract card last 4 digits
   */
  private extractCardLastFour(text: string, textLower: string, ocrConfidence: number): FieldValue<string> {
    for (const { pattern, confidence: patternConf } of this.cardPatterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        const lastFour = match[1];
        const finalConfidence = Math.min(patternConf * ocrConfidence, 0.98);
        
        console.log(`[Inference] Card: ****${lastFour} (confidence: ${finalConfidence.toFixed(2)})`);
        
        return {
          value: lastFour,
          confidence: finalConfidence,
          source: 'inference',
          rawText: match[0]
        };
      }
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Predict category based on keywords
   */
  private predictCategory(textLower: string, ocrConfidence: number): FieldValue<string> {
    let bestMatch: { category: string; confidence: number; keywords: string[] } | null = null;
    
    for (const [category, { keywords, weight }] of Object.entries(this.categoryKeywords)) {
      const matchedKeywords = keywords.filter(keyword => textLower.includes(keyword.toLowerCase()));
      
      if (matchedKeywords.length > 0) {
        // Calculate confidence based on number and quality of matches
        const matchScore = matchedKeywords.length / keywords.length;
        const confidence = Math.min((0.5 + matchScore * 0.4) * weight * ocrConfidence, 0.95);
        
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { category, confidence, keywords: matchedKeywords };
        }
      }
    }
    
    if (bestMatch) {
      console.log(`[Inference] Category: ${bestMatch.category} (confidence: ${bestMatch.confidence.toFixed(2)})`);
      console.log(`[Inference] Matched keywords: ${bestMatch.keywords.join(', ')}`);
      
      return {
        value: bestMatch.category,
        confidence: bestMatch.confidence,
        source: 'inference',
        rawText: bestMatch.keywords.join(', ')
      };
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Extract location/address with multiple patterns
   */
  private extractLocation(text: string, ocrConfidence: number): FieldValue<string> {
    const patterns = [
      // Full address with street, city, state, zip
      { regex: /\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway)\.?[\s,]*[A-Z][a-z]+[\s,]*[A-Z]{2}\s*\d{5}(?:-\d{4})?/i, confidence: 0.98 },
      
      // Street address with city and state (no zip)
      { regex: /\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway)\.?[\s,]+[A-Z][a-z]+[\s,]+[A-Z]{2}/i, confidence: 0.92 },
      
      // Street address (without city/state)
      { regex: /\d{1,5}\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway)\.?/i, confidence: 0.80 },
      
      // City, State ZIP
      { regex: /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?/i, confidence: 0.95 },
      
      // City, State (no ZIP)
      { regex: /[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}\b/i, confidence: 0.85 },
      
      // Common city names with known patterns
      { regex: /(?:Las\s+Vegas|Los\s+Angeles|New\s+York|San\s+Francisco|San\s+Diego|San\s+Jose|San\s+Antonio),?\s*(?:[A-Z]{2})?/i, confidence: 0.90 }
    ];
    
    const alternatives: Array<{ value: string; confidence: number }> = [];
    
    for (const { regex, confidence: patternConf } of patterns) {
      const match = text.match(regex);
      if (match) {
        const location = match[0].trim();
        const finalConfidence = Math.min(patternConf * ocrConfidence, 0.98);
        
        // Avoid duplicates
        if (!alternatives.find(a => a.value === location)) {
          alternatives.push({ value: location, confidence: finalConfidence });
        }
      }
    }
    
    // Sort by confidence and return best
    alternatives.sort((a, b) => b.confidence - a.confidence);
    
    if (alternatives.length > 0) {
      const best = alternatives[0];
      console.log(`[Inference] Location: "${best.value}" (confidence: ${best.confidence.toFixed(2)})`);
      
      return {
        value: best.value,
        confidence: best.confidence,
        source: 'inference',
        rawText: best.value
      };
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Extract tax amount
   */
  private extractTaxAmount(text: string, textLower: string, ocrConfidence: number): FieldValue<number> {
    const patterns = [
      /tax[\s:]*\$?\s*(\d+[.,]\d{2})/i,
      /sales\s+tax[\s:]*\$?\s*(\d+[.,]\d{2})/i
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1].replace(',', '.'));
        if (amount >= 0 && amount <= 10000) {
          return {
            value: amount,
            confidence: Math.min(0.85 * ocrConfidence, 0.90),
            source: 'inference',
            rawText: match[0]
          };
        }
      }
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Extract tip amount
   */
  private extractTipAmount(text: string, textLower: string, ocrConfidence: number): FieldValue<number> {
    const patterns = [
      /tip[\s:]*\$?\s*(\d+[.,]\d{2})/i,
      /gratuity[\s:]*\$?\s*(\d+[.,]\d{2})/i
    ];
    
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1].replace(',', '.'));
        if (amount >= 0 && amount <= 10000) {
          return {
            value: amount,
            confidence: Math.min(0.85 * ocrConfidence, 0.90),
            source: 'inference',
            rawText: match[0]
          };
        }
      }
    }
    
    return {
      value: null,
      confidence: 0,
      source: 'inference'
    };
  }
  
  /**
   * Suggest categories based on inference and OCR text
   */
  async suggestCategories(ocrResult: OCRResult, inference: FieldInference): Promise<CategorySuggestion[]> {
    const textLower = ocrResult.text.toLowerCase();
    const suggestions: CategorySuggestion[] = [];
    
    for (const [category, { keywords, weight }] of Object.entries(this.categoryKeywords)) {
      const matchedKeywords = keywords.filter(keyword => textLower.includes(keyword.toLowerCase()));
      
      if (matchedKeywords.length > 0) {
        const matchScore = matchedKeywords.length / keywords.length;
        const confidence = Math.min((0.5 + matchScore * 0.4) * weight * ocrResult.confidence, 0.95);
        
        suggestions.push({
          category,
          confidence,
          keywords: matchedKeywords,
          source: 'rule-based'
        });
      }
    }
    
    // Sort by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence);
    
    // Return top 3
    return suggestions.slice(0, 3);
  }
}

