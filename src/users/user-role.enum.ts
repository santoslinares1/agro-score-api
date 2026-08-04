export enum UserRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  USER = 'user',
}

export const ADMIN_ROLES = [UserRole.OWNER, UserRole.ADMIN] as const;
