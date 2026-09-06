'use client';

/**
 * 登录 / 注册页。
 *
 * 在 OPENMAIC_AUTH_REQUIRED=true 时由中间件把未登录的页面请求重定向到
 * 这里。成功登录/注册后整页跳转到首页（cookie 已由 API 设置）。
 */

import { useState, type FormEvent } from 'react';

type Mode = 'login' | 'register';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(
          mode === 'register' ? { name, password, inviteCode } : { name, password },
        ),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? '请求失败，请稍后重试');
        return;
      }
      window.location.href = '/';
    } catch {
      setError('网络错误，请检查连接后重试');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 15,
    outline: 'none',
  };

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <form
        onSubmit={submit}
        style={{
          width: 320,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: 28,
          borderRadius: 16,
          border: '1px solid rgba(128,128,128,0.3)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22, textAlign: 'center' }}>OpenMAIC</h1>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.65, textAlign: 'center' }}>
          {mode === 'login' ? '登录你的账户以继续' : '创建一个新账户'}
        </p>

        <input
          style={inputStyle}
          placeholder="用户名"
          value={name}
          autoComplete="username"
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          style={inputStyle}
          placeholder={mode === 'register' ? '密码（至少 8 位）' : '密码'}
          type="password"
          value={password}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {mode === 'register' && (
          <input
            style={inputStyle}
            placeholder="邀请码（如有）"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
          />
        )}

        {error && (
          <p style={{ margin: 0, fontSize: 13, color: '#e5484d', textAlign: 'center' }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            border: 'none',
            background: busy ? 'rgba(128,128,128,0.5)' : '#2563eb',
            color: '#fff',
            fontSize: 15,
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
          style={{
            padding: 0,
            border: 'none',
            background: 'none',
            color: '#2563eb',
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          {mode === 'login' ? '没有账户？注册一个' : '已有账户？直接登录'}
        </button>
      </form>
    </main>
  );
}
