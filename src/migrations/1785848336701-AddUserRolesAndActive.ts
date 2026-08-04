import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADMIN-1: agrega el sistema de roles/estado que consume /admin/*.
 *
 * IMPORTANTE — por qué esta migración resetea `role`:
 * La columna `role` ya existía desde el scaffold inicial con
 * DEFAULT 'owner', pero nunca tuvo efecto de autorización (no había ningún
 * guard que la leyera). Resultado: TODOS los usuarios reales creados hasta
 * hoy tienen role='owner' solo porque nunca se seteó nada distinto — no
 * porque alguien haya decidido que lo sean. Verificado contra la DB local
 * antes de escribir esta migración: 9/9 usuarios en 'owner'.
 *
 * A partir de esta ficha, role='owner'|'admin' desbloquea /admin/*. Si no
 * se tocan los datos existentes, cada usuario actual pasaría a tener acceso
 * admin de forma automática y silenciosa — exactamente lo que la consigna
 * pide evitar ("los usuarios actuales deben quedar como user por default").
 * Por eso el UPDATE de abajo baja a 'user' *solo* las filas que están en
 * 'owner' (el default nunca-usado), sin tocar ninguna fila que ya tuviera
 * otro valor por una intervención manual previa.
 *
 * Después de correr esta migración, promover al primer owner real es un
 * paso manual y explícito — ver scripts/promote-user-role.ts y
 * docs/admin-backend.md. Nunca queda ningún endpoint público que permita
 * auto-promoverse.
 */
export class AddUserRolesAndActive1785848336701 implements MigrationInterface {
    name = 'AddUserRolesAndActive1785848336701'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "isActive" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'user'`);
        await queryRunner.query(`UPDATE "users" SET "role" = 'user' WHERE "role" = 'owner'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // No revierte el UPDATE de datos: no hay forma de distinguir qué filas
        // estaban en 'owner' por default vs. las que ya se promovieron
        // legítimamente después de aplicar esta migración. Solo revierte el
        // esquema (default y columna). Si hace falta deshacer la promoción de
        // roles a mano, usar UPDATE directo o scripts/promote-user-role.ts.
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'owner'`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "isActive"`);
    }

}
