import { describe, expect, it } from 'vitest';
import { needsHeicConversion, convertedName } from '../lib/receiptImage';

describe('needsHeicConversion', () => {
  it('true for heic/heif mimetypes', () => {
    expect(needsHeicConversion('image/heic', 'a.heic')).toBe(true);
    expect(needsHeicConversion('image/heif', 'a.heif')).toBe(true);
  });
  it('true by extension even with generic mimetype', () => {
    expect(needsHeicConversion('application/octet-stream', 'IMG_0001.HEIC')).toBe(true);
    expect(needsHeicConversion('application/octet-stream', 'photo.heif')).toBe(true);
  });
  it('false for jpeg/png/pdf', () => {
    expect(needsHeicConversion('image/jpeg', 'a.jpg')).toBe(false);
    expect(needsHeicConversion('image/png', 'a.png')).toBe(false);
    expect(needsHeicConversion('application/pdf', 'a.pdf')).toBe(false);
  });
});

describe('convertedName', () => {
  it('replaces heic/heif extension with .jpg', () => {
    expect(convertedName('IMG_0001.HEIC')).toBe('IMG_0001.jpg');
    expect(convertedName('photo.heif')).toBe('photo.jpg');
  });
  it('appends .jpg when no heic extension present', () => {
    expect(convertedName('photo')).toBe('photo.jpg');
  });
});
