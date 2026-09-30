import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeneratedFile } from '../database/entities';
import { FilesController } from './files.controller';
import { GeneratedFilesService } from './generated-files.service';
import { ImageGenerationService } from './image-generation.service';

/** Files Gaspo makes during a run, and the public route that serves them. */
@Module({
  imports: [TypeOrmModule.forFeature([GeneratedFile])],
  controllers: [FilesController],
  providers: [GeneratedFilesService, ImageGenerationService],
  exports: [GeneratedFilesService, ImageGenerationService],
})
export class FilesModule {}
