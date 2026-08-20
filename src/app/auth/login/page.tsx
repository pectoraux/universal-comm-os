'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await signIn('credentials', {
      email,
      password,
      redirect: false,
    });

    if (res?.error) {
      setError(res.error);
      setLoading(false);
    } else {
      router.push('/');
      router.refresh();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <Card className="w-full max-w-md bg-slate-900/70 border-slate-800">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-center">Universal Comm OS</CardTitle>
          <CardDescription className="text-center text-slate-400">Sign in to your account</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-lg border border-red-700/50 bg-red-950/20 p-3 text-sm text-red-400">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="bg-slate-950 border-slate-700" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="bg-slate-950 border-slate-700" />
            </div>
            <Button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-500">
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <div className="mt-6 space-y-2">
            <div className="text-xs text-slate-500 uppercase tracking-wider text-center">Demo Quick Login</div>
            <div className="grid grid-cols-3 gap-2">
              <Button size="sm" variant="outline" onClick={() => { setEmail('demo-user@commos.dev'); setPassword('demo123456'); }} className="border-slate-700 text-slate-300 text-xs">
                User
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setEmail('demo-admin@commos.dev'); setPassword('demo123456'); }} className="border-slate-700 text-slate-300 text-xs">
                Admin
              </Button>
              <Button size="sm" variant="outline" onClick={() => { setEmail('demo-biz@commos.dev'); setPassword('demo123456'); }} className="border-slate-700 text-slate-300 text-xs">
                Business
              </Button>
            </div>
          </div>

          <div className="text-center mt-4">
            <a href="/auth/signup" className="text-sm text-emerald-400 hover:underline">Don't have an account? Join the waitlist</a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
