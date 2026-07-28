import { NavLink, Outlet, useLocation } from 'react-router-dom';
// `m` + LazyMotion loads only the DOM animation feature set, instead of the
// full `motion` bundle. We use opacity/transform transitions and nothing else,
// so the rest is dead weight on the critical path.
import { m, LazyMotion, domAnimation, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  LayoutDashboard,
  Wallet,
  ChartLine,
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
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/portfolio', label: 'Portfolio', icon: Wallet, end: false },
  { to: '/analytics', label: 'Analytics', icon: ChartLine, end: false },
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
    <div className="min-h-screen bg-bg">
      {/* Sidebar — collapses to a bottom bar under md. */}
      <aside
        className={cn(
          'fixed inset-x-0 bottom-0 z-20 flex h-16 items-center justify-around',
          'border-t border-border bg-surface/95 backdrop-blur',
          'md:inset-y-0 md:left-0 md:right-auto md:h-auto md:w-56 md:flex-col',
          'md:items-stretch md:justify-start md:border-r md:border-t-0 md:px-3 md:py-5',
        )}
      >
        <div className="hidden px-2 pb-6 md:block">
          <span className="text-base font-semibold tracking-tight text-text">
            Amin<span className="text-accent">Finance</span>
          </span>
          <p className="mt-0.5 text-[11px] text-text-subtle">Portfolio tracker</p>
        </div>

        <nav className="flex w-full items-center justify-around md:flex-col md:items-stretch md:gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center gap-1 rounded-lg px-3 py-2 text-[11px] font-medium',
                  'transition-colors duration-150',
                  'md:flex-row md:gap-3 md:text-sm',
                  isActive
                    ? 'text-accent md:bg-surface-raised'
                    : 'text-text-muted hover:text-text md:hover:bg-surface-raised',
                )
              }
            >
              <Icon className="size-5 md:size-4" strokeWidth={2} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="pb-16 md:pb-0 md:pl-56">
        <header
          className={cn(
            'sticky top-0 z-10 flex h-14 items-center justify-between gap-3',
            'border-b border-border bg-bg/85 px-4 backdrop-blur md:px-6',
          )}
        >
          <ServerStatus />

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

        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6 md:py-8">
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
                <Outlet />
              </m.div>
            </AnimatePresence>
          </LazyMotion>
        </main>
      </div>
    </div>
  );
}
