export type {
  OcrField,
  OcrResult,
  OcrAdapter,
  FieldValue,
  FieldInference,
  CategorySuggestion,
  CategoryKeywordRule,
  CategoryKeywordMap,
  InferredOcrResult,
} from './types';

export {
  OcrError,
  OcrAuthError,
  OcrInvalidFileError,
  OcrServiceUnavailableError,
  OcrPipelineError,
  OcrTimeoutError,
  OcrMalformedResponseError,
} from './errors';

export { MockOcrAdapter } from './adapters/mockAdapter';
export { ServiceOcrAdapter } from './adapters/serviceAdapter';
export type { ServiceOcrAdapterConfig } from './adapters/serviceAdapter';

export { RuleBasedInferenceEngine } from './inference/ruleBasedInferenceEngine';
export { DEFAULT_CATEGORY_KEYWORDS } from './inference/defaultCategoryKeywords';

export { prepareReceiptImageForOcr, cleanupPreparedFiles } from './preprocessing';
export type { PreparedReceiptImage } from './preprocessing';
