'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldCheck, CheckCircle2, XCircle, LogOut } from 'lucide-react';

export default function AdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const loadWaitlist = useCallback(async () => {
    const res = await fetch('/api/admin/waitlist');
    const data = await res.json();
    setEntries(data.entries || []);
  }, []);

  useEffect(() => {
    if (status === 'loading') return;
    if (!session) { router.push('/auth/login'); return; }
    if ((session.user as any)?.role !== 'admin') { router.push('/'); return; }
    setTimeout(() => { void loadWaitlist(); }, 0);
  }, [session, status, router, loadWaitlist]);

  const approve = useCallback(async (id: string, email: string) => {
    setLoading(true);
    await fetch('/api/admin/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, email }),
    });
    await loadWaitlist();
    setLoading(false);
  }, [loadWaitlist]);

  if (status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="container mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-emerald-400" />
            <h1 className="text-2xl font-bold">Admin Dashboard</h1>
          </div>
          <Button variant="outline" onClick={() => signOut({ callbackUrl: '/auth/login' })} className="border-slate-700 text-slate-400">
            <LogOut className="w-4 h-4 mr-2" /> Sign Out
          </Button>
        </div>

        <Card className="bg-slate-900/70 border-slate-800">
          <CardHeader>
            <CardTitle>Waitlist</CardTitle>
            <CardDescription>Approve users to give them access to the platform</CardDescription>
          </CardHeader>
          <CardContent>
            {entries.length === 0 ? (
              <div className="text-sm text-slate-500 italic">No pending waitlist entries.</div>
            ) : (
              <div className="space-y-2">
                {entries.map((e: any) => (
                  <div key={e.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-mono text-slate-300">{e.email}</div>
                      {e.name && <div className="text-xs text-slate-500">{e.name}</div>}
                      <div className="text-[10px] text-slate-500">{new Date(e.createdAt).toLocaleString()}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="border-amber-500 text-amber-400 text-[10px]">{e.status}</Badge>
                      {e.status === 'pending' && (
                        <Button size="sm" variant="outline" disabled={loading} onClick={() => approve(e.id, e.email)} className="border-emerald-600 text-emerald-400 hover:bg-emerald-950 h-7 text-xs">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Approve
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Button onClick={() => router.push('/')} className="bg-emerald-600 hover:bg-emerald-500">Go to App</Button>
      </div>
    </div>
  );
}
