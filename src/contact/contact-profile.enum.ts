export enum ContactProfile {
  PRODUCER = 'producer',
  AGRONOMIST = 'agronomist',
  CONSULTANCY = 'consultancy',
  TECHNICAL_TEAM = 'technical_team',
  OTHER = 'other',
}

export const CONTACT_PROFILE_LABELS: Record<ContactProfile, string> = {
  [ContactProfile.PRODUCER]: 'Productor',
  [ContactProfile.AGRONOMIST]: 'Asesor agronómico',
  [ContactProfile.CONSULTANCY]: 'Consultora',
  [ContactProfile.TECHNICAL_TEAM]: 'Equipo técnico',
  [ContactProfile.OTHER]: 'Otro',
};
