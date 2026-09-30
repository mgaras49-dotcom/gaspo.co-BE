import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A file Gaspo made during a run (a PDF or a generated image), kept in Postgres
 * and served at a public link that is its unguessable token.
 *
 * The link is the only delivery route: the Slack app has no `files:write`, and
 * adding it would mean every workspace re-adding Gaspo. Slack shows an image
 * from a public URL in an image block, and apps like Gmail can attach a file by
 * URL, so one stored copy covers both.
 */
@Entity({ name: 'generated_files' })
export class GeneratedFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Random, URL-safe, and the whole of the file's access control. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  token!: string;

  @Index()
  @Column({ type: 'uuid' })
  workspaceId!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  /** File name as downloaded, extension included. */
  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 100 })
  mimetype!: string;

  @Column({ type: 'integer' })
  size!: number;

  @Column({ type: 'bytea', select: false })
  data!: Buffer;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
