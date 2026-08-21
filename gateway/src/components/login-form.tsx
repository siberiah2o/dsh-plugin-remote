'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'

import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Field, FieldGroup, FieldLabel } from './ui/field'
import { Input } from './ui/input'

interface LoginInfo {
  siteName: string
  needsSetup: boolean
}

type Lang = 'zh' | 'en'

const DICTS: Record<Lang, Record<string, string>> = {
  zh: {
    title: '登录到您的账户',
    titleSetup: '创建初始管理员账户',
    subtitle: '输入邮箱登录您的账户',
    subtitleSetup: '首次访问：本设备创建唯一账户，凭据保存在服务器上。',
    email: '邮箱',
    emailPlaceholder: 'm@example.com',
    password: '密码',
    passwordPlaceholder: '请输入密码',
    submit: '登录',
    submitSetup: '创建账户并进入',
    errorInvalidCredentials: '用户名或密码错误',
    errorRateLimited: '尝试次数过多，请稍后再试',
    errorInvalidUsername: '用户名无效',
    errorPasswordTooShort: '密码至少 8 位',
    errorInvalidBody: '请求格式错误',
    errorLoginFailed: '登录失败',
    errorNetwork: '网络错误',
  },
  en: {
    title: 'Login to your account',
    titleSetup: 'Create the initial administrator account',
    subtitle: 'Enter your email below to login to your account',
    subtitleSetup: 'First visit: this device creates the only account. Credentials live on the server.',
    email: 'Email',
    emailPlaceholder: 'm@example.com',
    password: 'Password',
    passwordPlaceholder: 'Enter your password',
    submit: 'Login',
    submitSetup: 'Create account & enter',
    errorInvalidCredentials: 'Invalid username or password',
    errorRateLimited: 'Too many attempts, try again later',
    errorInvalidUsername: 'Invalid username',
    errorPasswordTooShort: 'Password must be at least 8 characters',
    errorInvalidBody: 'Invalid request',
    errorLoginFailed: 'Login failed',
    errorNetwork: 'Network error',
  },
}

const ERROR_KEYS: Record<string, keyof typeof DICTS.en> = {
  invalidCredentials: 'errorInvalidCredentials',
  rateLimited: 'errorRateLimited',
  invalidUsername: 'errorInvalidUsername',
  passwordTooShort: 'errorPasswordTooShort',
  invalidBody: 'errorInvalidBody',
}

function detectLang(): Lang {
  if (typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('zh')) return 'zh'
  return 'en'
}

export function LoginForm({
  initialLang,
  className,
  ...props
}: React.ComponentProps<'form'> & { initialLang?: Lang }) {
  const [lang, setLang] = useState<Lang>(initialLang ?? detectLang)
  const [info, setInfo] = useState<LoginInfo | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const t = useCallback((key: keyof typeof DICTS.en) => DICTS[lang][key] ?? key, [lang])

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  useEffect(() => {
    fetch('/login-info', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setInfo(d ?? { siteName: 'DSH Remote', needsSetup: false }))
      .catch(() => setInfo({ siteName: 'DSH Remote', needsSetup: false }))
  }, [])

  const submit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      setBusy(true)
      setError('')
      try {
        const r = await fetch('/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        const d = await r.json().catch(() => ({}))
        if (r.ok && d.ok === true) {
          window.location.href = '/'
          return
        }
        if (typeof d.code === 'string' && ERROR_KEYS[d.code]) {
          setError(t(ERROR_KEYS[d.code]))
          return
        }
        setError(typeof d.error === 'string' ? d.error : t('errorLoginFailed'))
      } catch {
        setError(t('errorNetwork'))
      } finally {
        setBusy(false)
      }
    },
    [username, password, t],
  )

  const isSetup = info?.needsSetup === true

  return (
    <form className={cn('flex flex-col gap-6', className)} onSubmit={submit} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">{isSetup ? t('titleSetup') : t('title')}</h1>
          <p className="text-sm text-balance text-muted-foreground">
            {isSetup ? t('subtitleSetup') : t('subtitle')}
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
          <Input
            id="email"
            name="username"
            type="text"
            inputMode="email"
            placeholder={t('emailPlaceholder')}
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={254}
            autoFocus
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            placeholder={t('passwordPlaceholder')}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </Field>
        {error && (
          <Field>
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          </Field>
        )}
        <Field>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? '…' : isSetup ? t('submitSetup') : t('submit')}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
