import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { FieldLot } from './field-lot.entity';

@Entity('fields')
export class Field {
  @PrimaryGeneratedColumn('uuid')
  id: string;

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
