export class OcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class OcrAuthError extends OcrError {}
export class OcrInvalidFileError extends OcrError {}
export class OcrServiceUnavailableError extends OcrError {}
export class OcrPipelineError extends OcrError {}
export class OcrTimeoutError extends OcrError {}
export class OcrMalformedResponseError extends OcrError {}
