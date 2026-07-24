import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await argon2.hash('Password123!', { type: argon2.argon2id });

  const brand = await prisma.user.upsert({
    where: { email: 'brand@example.com' },
    update: {},
    create: {
      email: 'brand@example.com',
      passwordHash,
      firstName: 'Brand',
      lastName: 'Owner',
      role: 'BRAND',
      companyName: 'Acme Inc.',
      companyUrl: 'https://acme.example.com',
      emailVerified: true,
    },
  });

  const affiliate = await prisma.user.upsert({
    where: { email: 'affiliate@example.com' },
    update: {},
    create: {
      email: 'affiliate@example.com',
      passwordHash,
      firstName: 'Affie',
      lastName: 'Liat',
      role: 'AFFILIATE',
      bio: 'I review SaaS products.',
      emailVerified: true,
    },
  });

  const campaign = await prisma.campaign.upsert({
    where: { slug: 'acme-affiliate-2026' },
    update: {},
    create: {
      brandId: brand.id,
      name: 'Acme Affiliate Program 2026',
      description: 'Earn 20% on every sale.',
      slug: 'acme-affiliate-2026',
      landingPageUrl: 'https://acme.example.com',
      allowedDomains: ['acme.example.com'],
      status: 'ACTIVE',
      commissionStructure: { type: 'percentage', percentage: 20 },
      attributionModel: 'LAST_CLICK',
      attributionWindowDays: 30,
      cookieLifetimeDays: 30,
      lockPeriodDays: 30,
      isOpen: true,
      startDate: new Date(),
    },
  });

  console.log({ brand: brand.email, affiliate: affiliate.email, campaign: campaign.slug });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
