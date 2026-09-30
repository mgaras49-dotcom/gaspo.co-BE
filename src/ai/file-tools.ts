import { IMAGE_ASPECT_RATIOS } from '../files/image-generation.service';
import type { ToolSpec } from './providers/provider.interface';

/**
 * Local tools that make files: a PDF from written content, and an image from a
 * prompt. Both return a public link; Slack shows generated images inline, and
 * apps that attach files by URL (Gmail drafts, for one) can take the link.
 *
 * The PDF tool rides on every run. The image tool rides only when an image
 * provider is configured, so without one the model says plainly it cannot make
 * images rather than calling a tool that always fails.
 */

export const CREATE_PDF = 'create_pdf';
export const GENERATE_IMAGE = 'generate_image';

export const FILE_TOOL_NAMES = new Set([CREATE_PDF, GENERATE_IMAGE]);

export const CREATE_PDF_TOOL: ToolSpec = {
  name: CREATE_PDF,
  description:
    'Make a PDF document — a report, strategy, proposal, plan, invoice-style summary or one-pager — ' +
    'and get a public download link. Write the full content in `content` as Markdown: # and ## ' +
    'headings, paragraphs, - bullets, 1. numbered lists, | tables | with a header divider row, ' +
    '**bold**, *italic*, [links](https://…) and --- rules. It is laid out as a clean A4 document ' +
    'with the title on top and page numbers. Use it whenever someone wants a PDF or a file to send ' +
    'or attach. Put the link in your reply; to attach it to an email, pass the link as the ' +
    "email app's attachment URL (Gmail: `attachments` plus `attachmentFilenames`).",
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Document title, printed large at the top.' },
      subtitle: {
        type: 'string',
        description: 'Optional line under the title, e.g. "Prepared for Acme · September 2026".',
      },
      content: {
        type: 'string',
        description: 'The whole document body as Markdown, excluding the title.',
      },
      file_name: {
        type: 'string',
        description: 'Optional file name without extension, e.g. "Meta Ads Strategy Q4".',
      },
    },
    required: ['title', 'content'],
  },
};

export const GENERATE_IMAGE_TOOL: ToolSpec = {
  name: GENERATE_IMAGE,
  description:
    'Create an image from a text prompt — ad creatives, product shots, social posts, thumbnails, ' +
    'illustrations, mockups — or edit/restyle images the user attached in this conversation. ' +
    'The image is shown in Slack under your reply automatically and you also get its link. Write ' +
    'a detailed visual prompt: subject, setting, composition, style, lighting, and any exact text ' +
    'to render in quotes. One image per call; call again for variations.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to make.' },
      aspect_ratio: {
        type: 'string',
        enum: [...IMAGE_ASPECT_RATIOS],
        description:
          'Shape of the image. 1:1 feed post, 4:5 Instagram/Facebook feed ad, 9:16 story/reel, ' +
          '16:9 banner or thumbnail. Default 1:1.',
      },
      use_attached_images: {
        type: 'boolean',
        description:
          'true to work from the images the user attached in this conversation (edit, restyle, ' +
          'put the product in a new scene). Default false.',
      },
      file_name: {
        type: 'string',
        description: 'Optional file name without extension.',
      },
    },
    required: ['prompt'],
  },
};
