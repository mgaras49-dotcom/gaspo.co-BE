import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { GeneratedFile } from '../database/entities';

/** Largest file Gaspo will store; Slack will not show an image over ~15 MB anyway. */
export const MAX_GENERATED_FILE_BYTES = 15 * 1024 * 1024;

/** A stored file, as the model and the chat surfaces see it. */
export interface StoredFile {
  name: string;
  mimetype: string;
  size: number;
  url: string;
}

/**
 * A file name safe for a URL path and a Content-Disposition header: no path
 * separators or control characters, a sane length, and the right extension.
 */
export function safeFileName(requested: string, extension: string): string {
  const stem = requested
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[^\p{L}\p{N} ._-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 80)
    .trim();
  return `${stem || 'gaspo-file'}.${extension}`;
}

@Injectable()
export class GeneratedFilesService {
  constructor(
    @InjectRepository(GeneratedFile)
    private readonly repository: Repository<GeneratedFile>,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  /** Store a file and return its public link. */
  async save(input: {
    workspaceId: string;
    userId: string | null;
    name: string;
    mimetype: string;
    data: Buffer;
  }): Promise<StoredFile> {
    if (input.data.length > MAX_GENERATED_FILE_BYTES) {
      throw new Error(
        `The file is ${Math.round(input.data.length / 1024 / 1024)} MB, over the 15 MB limit.`,
      );
    }
    const file = await this.repository.save(
      this.repository.create({
        token: randomBytes(24).toString('base64url'),
        workspaceId: input.workspaceId,
        userId: input.userId,
        name: input.name,
        mimetype: input.mimetype,
        size: input.data.length,
        data: input.data,
      }),
    );
    return { name: file.name, mimetype: file.mimetype, size: file.size, url: this.urlFor(file) };
  }

  /** A file with its bytes, by its link token; null when there is none. */
  findByToken(token: string): Promise<GeneratedFile | null> {
    return this.repository
      .createQueryBuilder('file')
      .addSelect('file.data')
      .where('file.token = :token', { token })
      .getOne();
  }

  urlFor(file: Pick<GeneratedFile, 'token' | 'name'>): string {
    const base = this.configService.get('app.publicApiUrl', { infer: true }).replace(/\/$/, '');
    return `${base}/files/${file.token}/${encodeURIComponent(file.name)}`;
  }
}
