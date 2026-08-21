import { headers } from 'next/headers'

import { LoginForm } from '../../components/login-form'
import { LoginPanel, WhaleMark } from '../../components/login-panel'

// Never serve a stale-cached login page: Next static prerenders send
// s-maxage=31536000, which made browsers/proxies reuse an old HTML that
// references a deleted CSS hash after a rebuild (white unstyled page).
export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  // Serve the login copy in the visitor's language on first paint (the form
  // keeps tracking navigator.language for later locale switches).
  const acceptLanguage = (await headers()).get('accept-language') || ''
  const initialLang = acceptLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Mobile/tablet: brand + form centered as a group; desktop (lg): brand
          pinned top-left, form centered in the remaining space beside the panel. */}
      <div className="flex flex-col justify-center gap-4 p-6 md:p-10 lg:justify-start">
        <div className="flex justify-center gap-2 md:justify-start">
          <a href="/" className="flex items-center gap-2 font-medium">
            <WhaleMark className="size-6 text-foreground" />
            DSH Remote
          </a>
        </div>
        <div className="flex items-center justify-center lg:flex-1">
          <div className="w-full max-w-xs">
            <LoginForm initialLang={initialLang} />
          </div>
        </div>
      </div>
      <div className="relative hidden lg:block">
        <LoginPanel />
      </div>
    </div>
  )
}
