import { IsOptional, IsString } from 'class-validator';

/**
 * Query Meta appends when redirecting the browser back after consent. On success
 * `code` and `state` are present; on denial/error Meta sends `error` instead.
 */
export class MetaCallbackDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  error?: string;

  // Meta adds these three plus `action=cancel` when the person backs out of the
  // dialog. The global pipe forbids unknown query keys, so without them listed
  // a cancel came back as a raw 400 JSON page instead of the dashboard.
  @IsOptional()
  @IsString()
  error_code?: string;

  @IsOptional()
  @IsString()
  error_description?: string;

  @IsOptional()
  @IsString()
  error_reason?: string;

  @IsOptional()
  @IsString()
  action?: string;
}
