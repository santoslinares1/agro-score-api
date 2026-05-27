import { PipelineInput } from '../lots/lots.service';

export type WorkerAnalysisResult = {
  globalScore: number;
  category: string;
  confidenceScore: number;
  productivityScore: number;
  stabilityScore: number;
  soilScore: number;
  climateScore: number;
  ndviAverageMax: number;
  ndviVariability: 'Baja' | 'Media' | 'Alta';
  zonesDetected: number;
  resultJson: {
    mode: 'fake' | 'python-worker';
    message: string;
    input: PipelineInput;
  };
};