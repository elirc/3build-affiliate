export const USER_ROLES = ['BRAND', 'AFFILIATE', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const RELATIONSHIP_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'DEACTIVATED',
] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];
