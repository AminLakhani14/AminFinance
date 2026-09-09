import { NavLink, Outlet, useLocation } from 'react-router-dom';
// `m` + LazyMotion loads only the DOM animation feature set, instead of the
// full `motion` bundle. We use opacity/transform transitions and nothing else,
// so the rest is dead weight on the critical path.
import { m, LazyMotion, domAnimation, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard,
  Wallet,
  ChartLine,
  Globe,
  Sparkles,
  Newspaper,
  Settings as SettingsIcon,
  Sun,
  Moon,
  Eye,
  EyeOff,
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/app/hooks';
import { toggleTheme, togglePrivacyMode } from '@/features/settings/settingsSlice';
import { ServerStatus } from './ServerStatus';
import { StreamStatus } from './StreamStatus';
import { TickerTape } from './TickerTape';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Logo, LogoMark } from '@/components/ui/Logo';
import { cn } from '@/lib/utils';
import { CosmicBackground } from './CosmicBackground';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet, end: false },
  { to: '/market', label: 'Market', icon: Globe, end: false },
  { to: '/analytics', label: 'Analytics', icon: ChartLine, end: false },
  { to: '/suggestions', label: 'AI', icon: Sparkles, end: false },
  { to: '/news', label: 'News', icon: Newspaper, end: false },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, end: false },
] as const;

export function AppShell() {
  const location = useLocation();
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.settings.theme);
  const privacyMode = useAppSelector((s) => s.settings.privacyMode);
  const reduceMotion = useReducedMotion();

  return (
    <div className="relative min-h-screen overflow-x-clip bg-bg">
      <CosmicBackground />
      {/* Sidebar — collapses to a bottom bar under md. */}
      <aside
        className={cn(
          'fixed inset-x-3 bottom-3 z-30 flex h-16 items-center justify-around',
          'rounded-2xl border border-border bg-surface/90 shadow-2xl backdrop-blur-2xl',
          'md:inset-y-3 md:left-3 md:right-auto md:h-auto md:w-60 md:flex-col',
          'md:items-stretch md:justify-start md:border md:px-3 md:py-5',
        )}
      >
        <Logo className="hidden px-2 pb-7 md:flex" />

        <nav className="flex w-full items-center justify-around md:flex-col md:items-stretch md:gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'group relative flex flex-col items-center gap-1 overflow-hidden rounded-xl px-3 py-2 text-[11px] font-medium',
                  'transition-all duration-200',
                  'md:flex-row md:gap-3 md:text-sm',
                  isActive
                    ? 'bg-accent/12 text-accent ring-1 ring-inset ring-accent/25'
                    : 'text-text-muted hover:bg-surface-raised/70 hover:text-text',
                )
              }
            >
              <Icon className="size-5 transition-transform duration-200 group-hover:scale-110 md:size-4" strokeWidth={1.8} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="relative z-10 pb-24 md:pb-0 md:pl-[16.5rem]">
        <header
          className={cn(
            'sticky top-0 z-20 flex h-16 items-center justify-between gap-3',
            'border-b border-border/80 bg-bg/55 px-4 backdrop-blur-2xl md:px-7',
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            {/* The sidebar (and its logo) becomes an icon-only bottom bar under
                md, so the mark moves up here to keep the app branded. */}
            <LogoMark className="size-7 shrink-0 md:hidden" />
            <ServerStatus />
            <StreamStatus />
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => dispatch(togglePrivacyMode())}
              title={privacyMode ? 'Show amounts' : 'Hide amounts'}
              aria-label={privacyMode ? 'Show amounts' : 'Hide amounts'}
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
            >
              {privacyMode ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            <button
              onClick={() => dispatch(toggleTheme())}
              title="Toggle theme"
              aria-label="Toggle theme"
              className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </div>
        </header>

        <TickerTape />

        <main className="mx-auto max-w-[1440px] px-4 py-6 md:px-7 md:py-8">
          {/* Keyed on pathname so each route animates in independently.
              Skipped entirely under prefers-reduced-motion. */}
          <LazyMotion features={domAnimation} strict>
            <AnimatePresence mode="wait">
              <m.div
                key={location.pathname}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                // Spread rather than passing `undefined` — under
                // exactOptionalPropertyTypes an explicit undefined is not the
                // same as an absent prop.
                {...(reduceMotion ? {} : { exit: { opacity: 0, y: -8 } })}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              >
                {/* Keyed on pathname too, so navigating away from a crashed
                    route mounts a fresh boundary rather than a stuck one. */}
                <ErrorBoundary key={location.pathname}>
                  <Outlet />
                </ErrorBoundary>
              </m.div>
            </AnimatePresence>
          </LazyMotion>
        </main>
      </div>
    </div>
  );
}
