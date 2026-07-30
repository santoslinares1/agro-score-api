import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { FieldLot } from './field-lot.entity';
import { User } from '../../users/user.entity';

@Entity('fields')
export class Field {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * NOT NULL desde AUTH-2: todo campo legacy sin dueño ya pasó por el
   * backfill (ver scripts/backfill-fields-user.ts) antes de aplicar la
   * migración que agrega esta constraint. Un field sin userId ya no es un
   * estado válido.
   */
  @Column()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  user?: User;

  @Column()
  name: string;

  @Column({ nullable: true })
  ownerName?: string;

  @Column({ nullable: true })
  location?: string;

  @Column({ nullable: true })
  province?: string;

  @Column({ nullable: true })
  country?: string;

  @Column({ type: 'jsonb', nullable: true })
  boundaryGeojson?: unknown;

  @Column({ type: 'float', default: 0 })
  totalAreaHa: number;

  @OneToMany(() => FieldLot, (lot) => lot.field, {
    cascade: true,
  })
  lots: FieldLot[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'int', default: 30 })
  maxCloudiness: number;
}
