import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1785445140411 implements MigrationInterface {
    name = 'InitialSchema1785445140411'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "analysis" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "lotId" character varying, "fieldId" character varying, "scope" character varying, "lotName" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'Procesando', "globalScore" integer NOT NULL DEFAULT '0', "category" character varying NOT NULL DEFAULT 'Procesando análisis', "confidenceScore" integer NOT NULL DEFAULT '0', "productivityScore" integer NOT NULL DEFAULT '0', "stabilityScore" integer NOT NULL DEFAULT '0', "soilScore" integer NOT NULL DEFAULT '0', "climateScore" integer NOT NULL DEFAULT '0', "ndviAverageMax" double precision NOT NULL DEFAULT '0', "ndviVariability" character varying NOT NULL DEFAULT 'Media', "zonesDetected" integer NOT NULL DEFAULT '0', "maxCloudiness" integer NOT NULL DEFAULT '30', "startDate" date NOT NULL, "endDate" date NOT NULL, "resultJson" jsonb, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_300795d51c57ef52911ed65851f" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "field_lots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "fieldId" uuid NOT NULL, "name" character varying NOT NULL, "geojson" jsonb NOT NULL, "areaHa" double precision NOT NULL DEFAULT '0', "displayOrder" integer NOT NULL DEFAULT '0', "includeInProductivityClassification" boolean NOT NULL DEFAULT true, "notes" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c9edf65b0362f90141e11948cad" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "passwordHash" character varying NOT NULL, "fullName" character varying NOT NULL, "companyName" character varying, "role" character varying NOT NULL DEFAULT 'owner', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "fields" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "userId" uuid, "name" character varying NOT NULL, "ownerName" character varying, "location" character varying, "province" character varying, "country" character varying, "boundaryGeojson" jsonb, "totalAreaHa" double precision NOT NULL DEFAULT '0', "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "startDate" date NOT NULL, "endDate" date NOT NULL, "maxCloudiness" integer NOT NULL DEFAULT '30', CONSTRAINT "PK_ee7a215c6cd77a59e2cb3b59d41" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "lots" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "location" character varying NOT NULL, "startDate" date NOT NULL, "endDate" date NOT NULL, "maxCloudiness" integer NOT NULL DEFAULT '30', "geojson" jsonb, "areaHa" double precision NOT NULL DEFAULT '0', "score" integer NOT NULL DEFAULT '0', "status" character varying NOT NULL DEFAULT 'Sin análisis', "lastAnalysisId" character varying, "lastAnalysisStatus" character varying, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_2bb990a4015865cb1daa1d22fd9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "field_lots" ADD CONSTRAINT "FK_25e77888de49597856a98aa83ec" FOREIGN KEY ("fieldId") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "fields" ADD CONSTRAINT "FK_5d8a9937b967b73f6415a3e488b" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "fields" DROP CONSTRAINT "FK_5d8a9937b967b73f6415a3e488b"`);
        await queryRunner.query(`ALTER TABLE "field_lots" DROP CONSTRAINT "FK_25e77888de49597856a98aa83ec"`);
        await queryRunner.query(`DROP TABLE "lots"`);
        await queryRunner.query(`DROP TABLE "fields"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP TABLE "field_lots"`);
        await queryRunner.query(`DROP TABLE "analysis"`);
    }

}
