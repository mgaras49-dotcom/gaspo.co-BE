import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Files Gaspo makes during a run (PDFs, generated images), stored with the
 * random token that is their public link.
 */
export class GeneratedFiles1736000000000 implements MigrationInterface {
  name = 'GeneratedFiles1736000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "generated_files" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "token" character varying(64) NOT NULL,
        "workspaceId" uuid NOT NULL,
        "userId" uuid,
        "name" character varying(255) NOT NULL,
        "mimetype" character varying(100) NOT NULL,
        "size" integer NOT NULL,
        "data" bytea NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_generated_files_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_generated_files_workspace" FOREIGN KEY ("workspaceId")
          REFERENCES "workspaces"("id") ON DELETE CASCADE
      )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_generated_files_token" ON "generated_files" ("token")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_generated_files_workspaceId" ON "generated_files" ("workspaceId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "generated_files"`);
  }
}
