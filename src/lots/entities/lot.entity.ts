import {
    Column,
    CreateDateColumn,
    Entity,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
  } from 'typeorm';
  
  export type LotStatus = 'Finalizado' | 'Procesando' | 'Sin análisis';
  
  @Entity('lots')
  export class Lot {
    @PrimaryGeneratedColumn('uuid')
    id: string;
  
    @Column()
    name: string;
  
    @Column()
    location: string;
  
    @Column({ type: 'date' })
    startDate: string;
  
    @Column({ type: 'date' })
    endDate: string;
  
    @Column({ type: 'int', default: 30 })
    maxCloudiness: number;
  
    @Column({ type: 'jsonb', nullable: true })
    geojson: any;
  
    @Column({ type: 'float', default: 0 })
    areaHa: number;
  
    @Column({ type: 'int', default: 0 })
    score: number;
  
    @Column({ default: 'Sin análisis' })
    status: LotStatus;
  
    @Column({ nullable: true })
    lastAnalysisId?: string;

    @Column({ nullable: true })
    lastAnalysisStatus?: 'Procesando' | 'Finalizado' | 'Error';
  
    @CreateDateColumn()
    createdAt: Date;
  
    @UpdateDateColumn()
    updatedAt: Date;
  }