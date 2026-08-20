/**
 * Seed the database with admin, demo accounts, organization, and node ownerships.
 */

import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const adminPassword = await bcrypt.hash('Payswap123456', 10);
  const demoPassword = await bcrypt.hash('demo123456', 10);

  // Create demo organization
  const org = await db.organization.upsert({
    where: { slug: 'demo-org' },
    update: {},
    create: { name: 'Demo Organization', slug: 'demo-org' },
  });
  console.log('Organization:', org.name);

  // Admin account
  const admin = await db.user.upsert({
    where: { email: 'ekontetevi@gmail.com' },
    update: {},
    create: {
      email: 'ekontetevi@gmail.com', name: 'Admin', password: adminPassword,
      role: 'admin', waitlist: false, approved: true,
    },
  });

  // Demo accounts
  const demoUsers = [
    ['demo-user@commos.dev', 'Demo User', 'demo'],
    ['demo-admin@commos.dev', 'Demo Admin', 'admin'],
    ['demo-biz@commos.dev', 'Demo Business', 'demo'],
  ];
  for (const [email, name, role] of demoUsers) {
    await db.user.upsert({
      where: { email },
      update: {},
      create: { email, name, password: demoPassword, role, waitlist: false, approved: true },
    });
  }

  // Create a second organization (for testing FORBIDDEN access)
  const org2 = await db.organization.upsert({
    where: { slug: 'other-org' },
    update: {},
    create: { name: 'Other Organization', slug: 'other-org' },
  });

  // Assign demo users to demo-org
  for (const email of ['demo-user@commos.dev', 'demo-admin@commos.dev', 'demo-biz@commos.dev']) {
    const u = await db.user.findUnique({ where: { email } });
    if (u) {
      await db.userOrganization.upsert({
        where: { userId_organizationId: { userId: u.id, organizationId: org.id } },
        update: {},
        create: { userId: u.id, organizationId: org.id, role: 'member' },
      });
    }
  }
  // demo-admin gets owner role
  const demoAdmin = await db.user.findUnique({ where: { email: 'demo-admin@commos.dev' } });
  if (demoAdmin) {
    await db.userOrganization.updateMany({
      where: { userId: demoAdmin.id, organizationId: org.id },
      data: { role: 'owner' },
    });
  }

  // Assign all 4 demo nodes to demo-org
  for (const nodeId of ['alice', 'bob', 'relay', 'gateway']) {
    await db.nodeOwnership.upsert({
      where: { nodeId },
      update: {},
      create: { nodeId, organizationId: org.id },
    });
  }

  // Assign admin to both orgs (for testing cross-org admin access)
  await db.userOrganization.upsert({
    where: { userId_organizationId: { userId: admin.id, organizationId: org.id } },
    update: {},
    create: { userId: admin.id, organizationId: org.id, role: 'owner' },
  });

  console.log('Done.');
}

main().catch(console.error).finally(() => db.$disconnect());
