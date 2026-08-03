import { ServiceOcrAdapter } from '@midas/ocr-client';

async function main() {
  const file = process.argv[2] || '/tmp/parity-receipt.png';
  const adapter = new ServiceOcrAdapter({
    baseUrl: process.env.OCR_BASE_URL || '',
    internalToken: process.env.OCR_SERVICE_INTERNAL_TOKEN || '',
    timeoutMs: Number(process.env.OCR_TIMEOUT_MS || 120000),
  });
  const result = await adapter.process(file, 'parity-test-midas');
  console.log(JSON.stringify({
    provider: result.provider,
    text: result.text,
    ocrConfidence: result.ocrConfidence,
    overallConfidence: result.overallConfidence,
    fields: result.fields,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
