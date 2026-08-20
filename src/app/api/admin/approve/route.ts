import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user as any)?.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id, email } = await req.json();

  // Approve the waitlist entry
  await db.waitlistEntry.update({
    where: { id },
    data: {
      status: 'approved',
      approvedAt: new Date(),
      approvedBy: session.user?.email || 'admin',
    },
  });

  // Approve the user (set a default password they can change later)
  const bcrypt = await import('bcryptjs');
  const tempPassword = Math.random().toString(36).slice(2, 10);
  const hashedPassword = await bcrypt.hash(tempPassword, 10);

  await db.user.update({
    where: { email: email.toLowerCase() },
    data: {
      waitlist: false,
      approved: true,
      password: hashedPassword,
    },
  });

  return NextResponse.json({ ok: true, tempPassword });
}
