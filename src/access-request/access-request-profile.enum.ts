export enum AccessRequestProfile {
  PRODUCER = 'producer',
  ADVISOR = 'advisor',
  CONSULTANCY = 'consultancy',
  AGRO_COMPANY = 'agro_company',
  OTHER = 'other',
}

export const ACCESS_REQUEST_PROFILE_LABELS: Record<AccessRequestProfile, string> = {
  [AccessRequestProfile.PRODUCER]: 'Productor',
  [AccessRequestProfile.ADVISOR]: 'Asesor',
  [AccessRequestProfile.CONSULTANCY]: 'Consultora',
  [AccessRequestProfile.AGRO_COMPANY]: 'Empresa agro',
  [AccessRequestProfile.OTHER]: 'Otro',
};
