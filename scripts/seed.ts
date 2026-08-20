/**
 * Seed the database with admin and demo accounts.
 * Run with: DATABASE_URL=... bun run db:seed
 */

import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const adminPassword = await bcrypt.hash('Payswap123456', 10);
  const demoPassword = await bcrypt.hash('demo123456', 10);

  // Admin account
  await db.user.upsert({
    where: { email: 'ekontetevi@gmail.com' },
    update: {},
    create: {
      email: 'ekontetevi@gmail.com',
      name: 'Admin',
      password: adminPassword,
      role: 'admin',
      waitlist: false,
      approved: true,
    },
  });
  console.log('Admin: ekontetevi@gmail.com');

  // Demo accounts
  for (const [email, name, role] of [
    ['demo-user@commos.dev', 'Demo User', 'demo'],
    ['demo-admin@commos.dev', 'Demo Admin', 'admin'],
    ['demo-biz@commos.dev', 'Demo Business', 'demo'],
  ] as const) {
    await db.user.upsert({
      where: { email },
      update: {},
      create: { email, name, password: demoPassword, role, waitlist: false, approved: true },
    });
    console.log(`${role}: ${email}`);
  }

  console.log('Done.');
}

main().catch(console.error).finally(() => db.$disconnect());
