import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function POST(req: NextRequest) {
  const { email, name } = await req.json();

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    return NextResponse.json({ error: 'This email is already registered.' }, { status: 409 });
  }

  await db.waitlistEntry.create({
    data: {
      email: email.toLowerCase(),
      name,
      status: 'pending',
    },
  });

  await db.user.create({
    data: {
      email: email.toLowerCase(),
      name,
      role: 'user',
      waitlist: true,
      approved: false,
    },
  });

  return NextResponse.json({ ok: true });
}
