import { WorkerResultJson } from 'src/python-worker/types';
import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AnalysisStatus = 'Procesando' | 'Finalizado' | 'Error';
export type NdviVariability = 'Baja' | 'Media' | 'Alta';

@Entity('analysis')
export class Analysis {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  lotId: string;

  @Column()
  lotName: string;

  @Column({ default: 'Procesando' })
  status: AnalysisStatus;

  @Column({ type: 'int', default: 0 })
  globalScore: number;

  @Column({ default: 'Procesando análisis' })
  category: string;

  @Column({ type: 'int', default: 0 })
  confidenceScore: number;

  @Column({ type: 'int', default: 0 })
  productivityScore: number;

  @Column({ type: 'int', default: 0 })
  stabilityScore: number;

  @Column({ type: 'int', default: 0 })
  soilScore: number;

  @Column({ type: 'int', default: 0 })
  climateScore: number;

  @Column({ type: 'float', default: 0 })
  ndviAverageMax: number;

  @Column({ default: 'Media' })
  ndviVariability: NdviVariability;

  @Column({ type: 'int', default: 0 })
  zonesDetected: number;

  @Column({ type: 'int', default: 30 })
  maxCloudiness: number;

  @Column({ type: 'date' })
  startDate: string;

  @Column({ type: 'date' })
  endDate: string;

  @Column({ type: 'jsonb', nullable: true })
  resultJson: WorkerResultJson | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
