import {
  Column,
  CreateDateColumn,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

import { Field } from './field.entity';

@Entity('field_lots')
export class FieldLot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  fieldId: string;

  @ManyToOne(() => Field, (field) => field.lots, {
    onDelete: 'CASCADE',
  })
  field: Field;

  @Column()
  name: string;

  @Column({ type: 'jsonb' })
  geojson: unknown;

  @Column({ type: 'float', default: 0 })
  areaHa: number;

  @Column({ type: 'int', default: 0 })
  displayOrder: number;

  @Column({ default: true })
  includeInProductivityClassification: boolean;

  @Column({ nullable: true })
  notes?: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
