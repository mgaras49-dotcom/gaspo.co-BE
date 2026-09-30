import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import OpenAI, { toFile } from 'openai';
import { AppConfig } from '../config/configuration';

/** Aspect ratios the image tool offers; both providers can serve each one. */
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
] as const;
export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

/** A picture to work from, e.g. a product photo the user attached. */
export interface ReferenceImage {
  mediaType: string;
  /** Base64 bytes. */
  data: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimetype: string;
  /** What the image cost us, at the provider's list price. */
  costUsd: number;
  provider: 'gemini' | 'openai';
  model: string;
}

/**
 * List price per image. Gemini 2.5 Flash Image is billed at $30 per million
 * output tokens and every image is 1,290 tokens, so $0.039 flat. gpt-image-1 at
 * medium quality is $0.042 square and $0.063 for the wide or tall sizes.
 */
const GEMINI_PRICE_USD = 0.039;
const OPENAI_PRICE_USD: Record<string, number> = {
  '1024x1024': 0.042,
  '1536x1024': 0.063,
  '1024x1536': 0.063,
};

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/** A refusal or failure worded for the model to pass on. */
export class ImageGenerationError extends Error {}

/**
 * Makes images from a prompt, optionally working from reference pictures.
 *
 * Gemini ("Nano Banana") is the default because it is cheaper and edits a
 * reference photo well; OpenAI's gpt-image is the fallback when only its key is
 * set. Both are plain HTTPS calls, so neither needs its own SDK beyond the
 * `openai` package the gateway provider already uses.
 */
@Injectable()
export class ImageGenerationService {
  private readonly logger = new Logger(ImageGenerationService.name);
  private openai: OpenAI | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  private get config(): AppConfig['images'] {
    return this.configService.get('images', { infer: true });
  }

  /** Whether any provider is set up; without one the tool is not offered. */
  isConfigured(): boolean {
    return Boolean(this.config.geminiApiKey || this.config.openaiApiKey);
  }

  async generate(input: {
    prompt: string;
    aspectRatio: ImageAspectRatio;
    references: ReferenceImage[];
  }): Promise<GeneratedImage> {
    if (this.config.geminiApiKey) return this.generateWithGemini(input);
    if (this.config.openaiApiKey) return this.generateWithOpenAi(input);
    throw new ImageGenerationError('Image generation is not set up on this Gaspo deployment.');
  }

  private async generateWithGemini(input: {
    prompt: string;
    aspectRatio: ImageAspectRatio;
    references: ReferenceImage[];
  }): Promise<GeneratedImage> {
    const model = this.config.geminiModel;
    const parts: unknown[] = [
      { text: input.prompt },
      ...input.references.map((image) => ({
        inline_data: { mime_type: image.mediaType, data: image.data },
      })),
    ];
    try {
      const { data } = await axios.post<GeminiResponse>(
        `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
        {
          contents: [{ role: 'user', parts }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: input.aspectRatio },
          },
        },
        {
          headers: { 'x-goog-api-key': this.config.geminiApiKey },
          timeout: 120_000,
          maxBodyLength: 40 * 1024 * 1024,
        },
      );
      const blocked = data.promptFeedback?.blockReason;
      if (blocked) {
        throw new ImageGenerationError(
          `Gemini refused the prompt (${blocked}). Rephrase it and try again.`,
        );
      }
      const candidate = data.candidates?.[0];
      const image = candidate?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
      if (!image?.data) {
        const said = candidate?.content?.parts
          ?.map((part) => part.text)
          .filter(Boolean)
          .join(' ');
        throw new ImageGenerationError(
          `Gemini returned no image (${candidate?.finishReason ?? 'no reason given'})${
            said ? `: ${said.slice(0, 300)}` : ''
          }`,
        );
      }
      return {
        bytes: Buffer.from(image.data, 'base64'),
        mimetype: image.mimeType ?? 'image/png',
        costUsd: GEMINI_PRICE_USD,
        provider: 'gemini',
        model,
      };
    } catch (error) {
      throw this.describe(error, 'Gemini');
    }
  }

  private async generateWithOpenAi(input: {
    prompt: string;
    aspectRatio: ImageAspectRatio;
    references: ReferenceImage[];
  }): Promise<GeneratedImage> {
    const model = this.config.openaiModel;
    this.openai ??= new OpenAI({ apiKey: this.config.openaiApiKey, timeout: 180_000 });
    const size = openAiSize(input.aspectRatio);
    try {
      const response = input.references.length
        ? await this.openai.images.edit({
            model,
            prompt: input.prompt,
            size,
            quality: 'medium',
            image: await Promise.all(
              input.references.map((image, index) =>
                toFile(Buffer.from(image.data, 'base64'), `reference-${index + 1}.png`, {
                  type: image.mediaType,
                }),
              ),
            ),
          })
        : await this.openai.images.generate({
            model,
            prompt: input.prompt,
            size,
            quality: 'medium',
          });
      const b64 = response.data?.[0]?.b64_json;
      if (!b64) throw new ImageGenerationError('OpenAI returned no image.');
      return {
        bytes: Buffer.from(b64, 'base64'),
        mimetype: `image/${response.output_format ?? 'png'}`,
        costUsd: OPENAI_PRICE_USD[size] ?? OPENAI_PRICE_USD['1024x1024'],
        provider: 'openai',
        model,
      };
    } catch (error) {
      throw this.describe(error, 'OpenAI');
    }
  }

  /** Reduce a provider failure to one line the model can relay. */
  private describe(error: unknown, provider: string): ImageGenerationError {
    if (error instanceof ImageGenerationError) return error;
    let detail: string;
    if (error instanceof AxiosError) {
      const body = error.response?.data as { error?: { message?: string } } | undefined;
      detail = body?.error?.message ?? error.message;
    } else {
      detail = error instanceof Error ? error.message : String(error);
    }
    this.logger.warn(`${provider} image generation failed: ${detail}`);
    return new ImageGenerationError(`${provider} could not make the image: ${detail}`);
  }
}

/** gpt-image serves three sizes; pick the one closest to the asked-for shape. */
export function openAiSize(ratio: ImageAspectRatio): '1024x1024' | '1536x1024' | '1024x1536' {
  const [w, h] = ratio.split(':').map(Number);
  if (w / h > 1.15) return '1536x1024';
  if (h / w > 1.15) return '1024x1536';
  return '1024x1024';
}

interface GeminiResponse {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
    };
  }>;
  promptFeedback?: { blockReason?: string };
}
