// DeepSeek-style login panel illustration — a stylized view of the DeepSeek
// Harness chat UI (light). Uses the real DeepSeek whale mark from DSH's
// /favicon.svg. Inlined as an SVG so the login page needs no extra public
// asset: the gateway only routes /login and /_next/* to Next.js, everything
// else goes through the auth check, so a public <img src="..."> would be
// redirected to /login and never render.

const WHALE_PATH = "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z"

/** The DeepSeek whale mark, standalone (fill = currentColor). */
export function WhaleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 50 50" className={className} aria-hidden="true">
      <path d={WHALE_PATH} fill="currentColor" />
    </svg>
  )
}

export function LoginPanel() {
  return (
    <svg
      viewBox="0 0 900 1200"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      role="img"
      aria-label="DeepSeek Harness"
    >
      <defs>
        <linearGradient id="dsp-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#eef1f8" />
        </linearGradient>
        <radialGradient id="dsp-glow" cx="0.55" cy="0.12" r="0.9">
          <stop offset="0" stopColor="#4d6bfe" stopOpacity="0.1" />
          <stop offset="1" stopColor="#4d6bfe" stopOpacity="0" />
        </radialGradient>
        <path id="dsp-whale" d={WHALE_PATH} fill="#18181b" />
      </defs>

      <rect width="900" height="1200" fill="url(#dsp-bg)" />
      <rect width="900" height="1200" fill="url(#dsp-glow)" />

      {/* faint grid */}
      <g stroke="#18181b" strokeOpacity="0.04">
        {Array.from({ length: 11 }, (_, i) => (i + 1) * 75).map((x) => (
          <line key={'v' + x} x1={x} y1="0" x2={x} y2="1200" />
        ))}
        {Array.from({ length: 15 }, (_, i) => (i + 1) * 75).map((y) => (
          <line key={'h' + y} x1="0" y1={y} x2="900" y2={y} />
        ))}
      </g>

      {/* header */}
      <g fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
        <use href="#dsp-whale" transform="translate(72 22) scale(1.5)" />
        <text x="172" y="76" fill="#18181b" fontSize="26" fontWeight="600">
          DeepSeek Harness
        </text>
        <text x="172" y="104" fill="#71717a" fontSize="16">
          DeepSeek Harness Web GUI
        </text>
      </g>
      <line x1="72" y1="130" x2="828" y2="130" stroke="#18181b" strokeOpacity="0.08" />

      {/* user message */}
      <g>
        <rect x="520" y="180" width="312" height="96" rx="18" fill="#e9edff" />
        <rect x="556" y="210" width="236" height="13" rx="6.5" fill="#18181b" fillOpacity="0.8" />
        <rect x="556" y="234" width="168" height="13" rx="6.5" fill="#18181b" fillOpacity="0.5" />
      </g>

      {/* assistant reply */}
      <g>
        <circle cx="84" cy="352" r="24" fill="#ffffff" stroke="#d9deeb" strokeWidth="1.5" />
        <use href="#dsp-whale" transform="translate(66 334) scale(0.72)" />
        <rect x="128" y="300" width="620" height="190" rx="18" fill="#ffffff" stroke="#e2e6f0" />
        <rect x="148" y="322" width="142" height="26" rx="13" fill="#e6ebff" />
        <text x="164" y="340" fill="#3b5bdb" fontSize="14" fontWeight="500" fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
          deepseek-chat
        </text>
        <rect x="148" y="370" width="520" height="13" rx="6.5" fill="#18181b" fillOpacity="0.78" />
        <rect x="148" y="394" width="460" height="13" rx="6.5" fill="#18181b" fillOpacity="0.5" />
        <rect x="148" y="418" width="380" height="13" rx="6.5" fill="#18181b" fillOpacity="0.5" />
        <rect x="148" y="446" width="556" height="13" rx="6.5" fill="#18181b" fillOpacity="0.35" />
      </g>

      {/* reasoning reply with code block */}
      <g>
        <circle cx="84" cy="592" r="24" fill="#ffffff" stroke="#d9deeb" strokeWidth="1.5" />
        <use href="#dsp-whale" transform="translate(66 574) scale(0.72)" />
        <rect x="128" y="540" width="520" height="180" rx="18" fill="#ffffff" stroke="#e2e6f0" />
        <rect x="148" y="562" width="148" height="26" rx="13" fill="#f1f2f6" />
        <text x="164" y="580" fill="#52525b" fontSize="14" fontWeight="500" fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
          deepseek-reasoner
        </text>
        <rect x="148" y="612" width="440" height="13" rx="6.5" fill="#18181b" fillOpacity="0.78" />
        <rect x="148" y="636" width="360" height="13" rx="6.5" fill="#18181b" fillOpacity="0.5" />
        <rect x="148" y="662" width="472" height="42" rx="10" fill="#f7f8fb" stroke="#e2e6f0" />
        <rect x="168" y="676" width="200" height="11" rx="5.5" fill="#0ea5e9" fillOpacity="0.85" />
        <rect x="168" y="690" width="150" height="11" rx="5.5" fill="#6366f1" fillOpacity="0.85" />
      </g>

      {/* user follow-up */}
      <g>
        <rect x="560" y="772" width="252" height="80" rx="18" fill="#e9edff" />
        <rect x="596" y="800" width="180" height="13" rx="6.5" fill="#18181b" fillOpacity="0.8" />
        <rect x="596" y="824" width="120" height="13" rx="6.5" fill="#18181b" fillOpacity="0.5" />
      </g>

      {/* tool use card */}
      <g>
        <circle cx="84" cy="942" r="24" fill="#ffffff" stroke="#d9deeb" strokeWidth="1.5" />
        <use href="#dsp-whale" transform="translate(66 924) scale(0.72)" />
        <rect x="128" y="892" width="600" height="120" rx="18" fill="#ffffff" stroke="#e2e6f0" />
        <rect x="148" y="914" width="170" height="26" rx="13" fill="#f1f2f6" />
        <text x="164" y="932" fill="#52525b" fontSize="14" fontWeight="500" fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
          tool · web_search
        </text>
        <rect x="148" y="962" width="480" height="13" rx="6.5" fill="#18181b" fillOpacity="0.4" />
      </g>

      {/* input bar */}
      <g>
        <rect x="72" y="1048" width="756" height="84" rx="24" fill="#ffffff" stroke="#d7dbe5" />
        <text x="120" y="1091" fill="#a1a1aa" fontSize="18" fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">
          发送消息，输入 / 查看命令 …
        </text>
        <circle cx="774" cy="1090" r="24" fill="#4d6bfe" />
        <path d="M766 1083 L766 1097 L778 1090 Z" fill="#ffffff" />
      </g>
    </svg>
  )
}
