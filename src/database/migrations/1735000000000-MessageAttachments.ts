import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Files attached to a conversation turn, stored as Slack file references so a
 * follow-up in the same thread can fetch the document again rather than
 * forgetting it after the message it came with.
 */
export class MessageAttachments1735000000000 implements MigrationInterface {
  name = 'MessageAttachments1735000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" ADD "attachments" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "attachments"`);
  }
}
