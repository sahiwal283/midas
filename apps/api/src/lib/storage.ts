import path from 'path';
import fs from 'fs/promises';
import { env } from '../config/env';

export interface StoredFile {
  storagePath: string;
  publicUrl: string;
}

export interface StorageAdapter {
  save(buffer: Buffer, filename: string, mimeType: string): Promise<StoredFile>;
  delete(storagePath: string): Promise<void>;
  getUrl(storagePath: string): string;
}

class LocalStorageAdapter implements StorageAdapter {
  private readonly uploadsDir: string;

  constructor() {
    this.uploadsDir = env.UPLOADS_DIR;
    fs.mkdir(this.uploadsDir, { recursive: true }).catch(() => {});
  }

  async save(buffer: Buffer, filename: string, _mimeType: string): Promise<StoredFile> {
    const safeFilename = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const fullPath = path.join(this.uploadsDir, safeFilename);
    await fs.writeFile(fullPath, buffer);
    return {
      storagePath: safeFilename,
      publicUrl: `/uploads/${safeFilename}`,
    };
  }

  async delete(storagePath: string): Promise<void> {
    const fullPath = path.join(this.uploadsDir, storagePath);
    await fs.unlink(fullPath).catch(() => {});
  }

  getUrl(storagePath: string): string {
    return `/uploads/${storagePath}`;
  }
}

// Future: S3StorageAdapter goes here, toggled by STORAGE_MODE=s3
export const storage: StorageAdapter = new LocalStorageAdapter();
