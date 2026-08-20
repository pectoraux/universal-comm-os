'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Something went wrong');
      } else {
        setSuccess(true);
      }
    } catch {
      setError('Network error');
    }
    setLoading(false);
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
        <Card className="w-full max-w-md bg-slate-900/70 border-slate-800">
          <CardHeader>
            <CardTitle className="text-2xl font-bold text-center text-emerald-400">You're on the waitlist!</CardTitle>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <p className="text-slate-400">We've added <span className="text-emerald-400">{email}</span> to the waitlist. An admin will approve your account soon.</p>
            <Button onClick={() => router.push('/auth/login')} className="bg-emerald-600 hover:bg-emerald-500">Back to Login</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <Card className="w-full max-w-md bg-slate-900/70 border-slate-800">
        <CardHeader>
          <CardTitle className="text-2xl font-bold text-center">Join the Waitlist</CardTitle>
          <CardDescription className="text-center text-slate-400">Sign up to get early access to Universal Comm OS</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="rounded-lg border border-red-700/50 bg-red-950/20 p-3 text-sm text-red-400">{error}</div>
            )}
            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input id="name" type="text" value={name} onChange={(e) => setName(e.target.value)} className="bg-slate-950 border-slate-700" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="bg-slate-950 border-slate-700" />
            </div>
            <Button type="submit" disabled={loading} className="w-full bg-emerald-600 hover:bg-emerald-500">
              {loading ? 'Joining...' : 'Join Waitlist'}
            </Button>
          </form>
          <div className="text-center mt-4">
            <a href="/auth/login" className="text-sm text-emerald-400 hover:underline">Already have an account? Sign in</a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
