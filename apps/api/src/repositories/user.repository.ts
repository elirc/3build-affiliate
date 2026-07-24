import type { DB } from '../config/prisma';
import type { UserRole } from '@affiliate/shared';

export function userRepository(db: DB) {
  return {
    findByEmail: (email: string) =>
      db.user.findUnique({ where: { email: email.toLowerCase() } }),

    findById: (id: string) => db.user.findUnique({ where: { id } }),

    create: (data: {
      email: string;
      passwordHash: string;
      firstName: string;
      lastName: string;
      role: UserRole;
      companyName?: string;
      companyUrl?: string;
    }) =>
      db.user.create({
        data: { ...data, email: data.email.toLowerCase() },
      }),

    bumpTokenVersion: (id: string) =>
      db.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } }),
  };
}
