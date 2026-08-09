import { useState, type FormEvent } from 'react';
import { Mic2 } from 'lucide-react';
import { api } from './api.js';
import { Button } from './components.js';

export function AuthScreen({ setupRequired, onSuccess }: { setupRequired: boolean; onSuccess(): void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api(setupRequired ? '/api/setup' : '/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      onSuccess();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  return <div className="auth-screen"><div className="brand-mark"><Mic2 size={40} /></div><p className="eyebrow">PICKNEXT</p><h1>话筒递给我</h1><p className="auth-intro">别再纠结下一首。把会唱的歌交给 Pick。</p>
    <form onSubmit={submit} className="auth-card"><h2>{setupRequired ? '创建管理员' : '欢迎回来'}</h2><label>用户名<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} minLength={2} required /></label><label>密码<input type="password" autoComplete={setupRequired ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required /></label>{error && <p className="form-error">{error}</p>}<Button disabled={busy} type="submit">{setupRequired ? '完成初始化' : '登录'}</Button></form>
  </div>;
}
