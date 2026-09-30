import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators';
import { GeneratedFilesService } from './generated-files.service';

/**
 * Serves the files Gaspo makes (PDFs, images) at their public link. The token
 * in the path is the access control: whoever has the link has the file, the
 * same as a Slack public file link. The trailing name is for readable URLs and
 * is not checked.
 */
@ApiTags('files')
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: GeneratedFilesService) {}

  @Public()
  @Get(':token/:name')
  download(@Param('token') token: string, @Res() res: Response): Promise<void> {
    return this.send(token, res);
  }

  @Public()
  @Get(':token')
  downloadBare(@Param('token') token: string, @Res() res: Response): Promise<void> {
    return this.send(token, res);
  }

  private async send(token: string, res: Response): Promise<void> {
    const file = /^[A-Za-z0-9_-]{16,64}$/.test(token)
      ? await this.filesService.findByToken(token)
      : null;
    if (!file) throw new NotFoundException('File not found');
    const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', file.mimetype);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    res.setHeader('Cache-Control', 'private, max-age=86400');
    // Helmet's default of same-origin would stop a Gaspo page or an email from
    // showing a generated image; the file is already public to its link holder.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(file.data);
  }
}
